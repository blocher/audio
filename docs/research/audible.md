# Audible integration research (audible / audible-cli / ffmpeg)

Researched 2026-11-02 against primary sources:

- `audible` (mkb79/Audible) at commit [`2460f9e`](https://github.com/mkb79/Audible/tree/2460f9edff039d4b098d87be1fe7248381976bd7) (= release **0.13.1**, 2026-10-23/24)
- `audible-cli` (mkb79/audible-cli) at commit [`274539e`](https://github.com/mkb79/audible-cli/tree/274539eba80a63ddccb79a9ec4f59b2fe911e232) (= release **0.6.0**, 2026-09-01)
- `artvandelay/audible-aax-to-mp3` at commit [`8121ec2`](https://github.com/artvandelay/audible-aax-to-mp3/tree/8121ec24ae99abafe4678dbf590bf04fcc5e517d)
- Local ffmpeg 9.0.2 (Homebrew)

Link shorthands used below:

- `A/` = `https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/`
- `CLI/` = `https://github.com/mkb79/audible-cli/blob/274539eba80a63ddccb79a9ec4f59b2fe911e232/`

Audible has **no public API documentation**. The endpoint reference that exists is the community one in
[`A/docs/source/misc/external_api.rst`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/docs/source/misc/external_api.rst).
Anything about response *shapes* comes from that file, audible-cli code, or other projects' recorded responses, and is
marked as such.

---

## 0. Package versions and Python support

| Package | Latest on PyPI | `requires_python` | Notes |
|---|---|---|---|
| `audible` | **0.13.1** (2026-10-24) | `>=3.11,<3.15` | Classifiers: 3.11, 3.12, 3.13, 3.14 |
| `audible-cli` | **0.6.0** (2026-09-01) | `>=3.11,<3.15` | depends on `audible>=0.11.0` |

Source: `https://pypi.org/pypi/audible/json`, `https://pypi.org/pypi/audible-cli/json`.

- **Python 3.13 and 3.14 are supported.** I installed `audible[cryptography]==0.13.1` into fresh 3.13 and 3.14
  venvs and ran an offline smoke test (build the OAuth URL, `from_dict` → `to_dict` → encrypted `to_file` →
  `from_file`). All of it worked.
- **Python 3.15 is not supported.** The default `python3` on this machine is 3.15.0. `pip` will refuse the install,
  because every release has an upper bound (0.10.0 is `<3.13`, 0.9.1 is `<3.12`). `uv` ignores the upper bound, so
  it installs 0.13.1 on 3.15, and my offline smoke test passed there too. That is still unsupported. Pin the
  backend to 3.13 or 3.14.
- Install `audible[cryptography]`. It is optional, but it picks a Rust-backed AES/RSA provider (5–20x faster per
  the [CHANGELOG](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/CHANGELOG.md) for
  0.11.0). Without it you get the pure-Python `pyaes`/`rsa` fallback. RSA request signing runs on every API call.
- Recent behaviour changes that matter:
  - 0.12.0: bearer auth now sends `x-amz-access-token` instead of `Authorization: Bearer`. Token refresh is guarded
    by a `threading.Lock`, and an `asyncio.Lock` for `AsyncClient`.
  - 0.13.1: registers as an "Audible for iPhone 4.60" device profile
    ([`A/src/audible/_device.py`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/_device.py):
    `APP_VERSION="4.60"`, `OS_VERSION="26.2"`, `SOFTWARE_VERSION="46000856"`).
  - Amazon breaks old device profiles from time to time, so keep the package up to date.
- **Thread-safety:** the `Authenticator` docstring says instances are **not thread-safe**
  ([`A/src/audible/auth.py#L273`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/auth.py#L273)).
  In Celery, build a fresh `Authenticator` from the stored dict inside each task and don't share it across threads.

---

## 1. Login and device registration for several accounts from a web UI

### 1.1 Why `Authenticator.from_login_external` alone doesn't fit a web app

```python
# A/src/audible/auth.py#L566
@classmethod
def from_login_external(cls, locale: str | Locale, serial: str | None = None,
                        with_username: bool = False,
                        login_url_callback: Callable[[str], str] | None = None,
                        crypto_provider=None) -> Authenticator
```

It calls `login.external_login(...)`, which generates the PKCE verifier, builds the URL and then **calls
`login_url_callback(oauth_url)` synchronously**, expecting the final redirect URL back. After that it calls
`register()`
([`A/src/audible/login.py#L606-L661`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/login.py#L606-L661)).
Everything happens inside one call. A web app needs two HTTP requests, so it uses the building blocks directly.
That is what `external_login` does internally, and it is how Music Assistant's Audible provider does it
(`music_assistant/providers/audible/audible_helper.py`: `audible_get_auth_info` / `audible_custom_login`).

### 1.2 The building blocks (exact signatures)

From [`A/src/audible/login.py`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/login.py):

```python
def create_code_verifier(length: int = 32) -> bytes            # L236 – urlsafe b64 of 32 random bytes, no '=' (43 bytes)
def create_s256_code_challenge(verifier: bytes) -> bytes        # L241
def build_device_serial() -> str                                # L246 – 40 random [A-Za-z0-9]
def build_client_id(serial: str) -> str                         # L256 – hex(serial + "#A2CZJZGLK2JJVM")
def build_oauth_url(country_code: str, domain: str, market_place_id: str,
                    code_verifier: bytes, serial: str | None = None,
                    with_username: bool = False) -> tuple[str, str]   # L261 – returns (oauth_url, serial)
def build_init_cookies() -> dict[str, str]                      # L314 – frc / map-md / amzn-app-id anti-captcha cookies
def extract_code_from_url(url: httpx.URL) -> str                # L377 – parse_qs(...)["openid.oa2.authorization_code"][0]
```

`build_oauth_url` returns `https://www.amazon.{domain}/ap/signin?...` with `openid.return_to =
https://www.amazon.{domain}/ap/maplanding`, `openid.oa2.client_id=device:{client_id}`,
`openid.oa2.code_challenge_method=S256`, `openid.oa2.scope=device_auth_access`, `pageId=amzn_audible_ios`,
`openid.assoc_handle=amzn_audible_ios_{country_code}`, and `marketPlaceId`. If `serial` is `None` it generates one
and returns it. **You must persist the serial**, because registration has to use the same one.

From [`A/src/audible/register.py#L11`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/register.py#L11-L107):

```python
def register(authorization_code: str, code_verifier: bytes, domain: str,
             serial: str, with_username: bool = False) -> dict[str, Any]
```

It POSTs to `https://api.amazon.{domain}/auth/register`, requesting the token types `bearer`, `mac_dms`,
`website_cookies` and `store_authentication_cookie`, plus the extensions `device_info` and `customer_info`. It
raises a plain `Exception(resp_json)` on any non-200. It returns:

```python
{"adp_token", "device_private_key", "access_token", "refresh_token", "expires",  # expires = unix ts (float)
 "website_cookies", "store_authentication_cookie", "device_info", "customer_info"}
```

`device_info` contains `device_serial_number` and `device_type`. `customer_info` contains `user_id`. Voucher
decryption needs both (section 3.3).

Also in `register.py`:
`deregister(access_token, domain, deregister_all=False, with_username=False)` (L110). The method form is
`auth.deregister_device(deregister_all=False)`
([`auth.py#L851`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/auth.py#L851)).
**Every registration shows up in the user's Amazon device list until it is deregistered**
([`A/docs/source/auth/register.rst`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/docs/source/auth/register.rst)).
Offer a "disconnect" action that calls `deregister_device()`. Never register twice for the same account without
deregistering first.

### 1.3 Two-step web flow (sketch, not app code)

**Request 1, "Connect Audible account" (POST with a locale such as `us`/`uk`/`de`):**

```python
from audible.localization import Locale
from audible.login import create_code_verifier, build_oauth_url

loc = Locale("uk")                       # country_code -> domain/marketplace via LOCALE_TEMPLATES
code_verifier = create_code_verifier()   # bytes
oauth_url, serial = build_oauth_url(
    country_code=loc.country_code, domain=loc.domain,
    market_place_id=loc.market_place_id, code_verifier=code_verifier,
    with_username=False,
)
# persist (encrypted) on the account row: {"code_verifier": code_verifier.decode(), "serial": serial, "locale": "uk"}
# show oauth_url to the user as a link (target=_blank) + a text box for the result URL
```

**User:** opens the link and signs in to Amazon (password, 2FA/OTP, captcha, approval, all handled by Amazon in the
user's own browser). Amazon then redirects to `https://www.amazon.{domain}/ap/maplanding?...openid.oa2.authorization_code=...`.
That page shows an error or "page not found". **This is expected.** The user copies the URL from the address bar
and pastes it into your form.

**Request 2, "Finish" (POST with the pasted URL):**

```python
from urllib.parse import urlsplit, parse_qs
import audible
from audible.register import register

pending = ...  # load + decrypt the pending_login JSON
qs = parse_qs(urlsplit(pasted_url).query)
code = qs["openid.oa2.authorization_code"][0]          # KeyError -> tell the user they pasted the wrong URL

reg = register(authorization_code=code,
               code_verifier=pending["code_verifier"].encode(),
               domain=Locale(pending["locale"]).domain,
               serial=pending["serial"])
auth = audible.Authenticator.from_dict({**reg, "locale_code": pending["locale"], "with_username": False})
# store auth.to_dict() (encrypted), clear pending_login
```

Notes and caveats:

- `Authenticator.from_dict(data, locale=None, *, crypto_provider=None)`
  ([`auth.py#L389`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/auth.py#L389)) **pops
  keys out of the dict you pass**, so pass a copy. Every key is validated by regex on assignment (`utils.test_convert`):
  - `adp_token` must match `{enc:…}{key:…}{iv:…}{name:…}{serial:Mg==}`
  - `access_token` must start `Atna|`
  - `refresh_token` must start `Atnr|`
  - `device_private_key` must be a PEM block
  - unknown attributes raise `AttributeError`, because the class is "frozen"

  Music Assistant's equivalent is `auth = Authenticator(); auth.locale = Locale(x); auth._update_attrs(**reg)`.
  `from_dict` gives the same result without the private method.
- **The external browser has no anti-captcha cookies.** `build_init_cookies()` (`frc`, `map-md`, `amzn-app-id`)
  can't be set on amazon.* from our origin. The library's own text in `default_login_url_callback` warns the user may
  have to "login … a second time and solving a captcha". Put that in the UI copy.
- **Code lifetime: unverified.** I found no source for how long `openid.oa2.authorization_code` stays valid. Treat it
  as short-lived and register right after the paste. The same applies to how long a pending `code_verifier`/serial
  stays useful: regenerate on every "Connect" click.
- `with_username=True` is only for legacy pre-Amazon Audible accounts (DE/US/UK only, `build_oauth_url` raises
  otherwise). We can ignore it.
- Multiple accounts: one registration (one `auth` dict, one serial) per account row. Nothing in the library is
  global. Customer identity: `auth.customer_info["user_id"]` is in the registration response. For a display name or
  email, call `auth.user_profile()`, which GETs `https://api.amazon.{domain}/user/profile` with the access token
  ([`auth.py#L172`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/auth.py#L172)).
- Optional alternative: `audible.login.playwright_external_login_url_callback` drives a headful Chromium and captures
  the maplanding request. Not useful server-side.

### 1.4 Locales / country codes

`LOCALE_TEMPLATES` in [`A/src/audible/localization.py#L10`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/localization.py#L10-L66).
`Locale("uk")` looks up by `country_code`. `Locale(domain="co.uk")` also works.

| country_code | domain | market_place_id |
|---|---|---|
| `us` | `com` | `AF2M0KC94RCEA` |
| `uk` | `co.uk` | `A2I9A3Q2GNFNGQ` |
| `de` | `de` | `AN7V1F1VY261K` |
| `fr` | `fr` | `A2728XDNODOQ8T` |
| `ca` | `ca` | `A2CQZ5RBY40XE` |
| `it` | `it` | `A2N7FU2W2BU2ZC` |
| `au` | `com.au` | `AN7EY7DTAW63G` |
| `in` | `in` | `AJO3FBRUE6J4S` |
| `jp` | `co.jp` | `A1QAP3MOU4173J` |
| `es` | `es` | `ALMIKO4SZCSAR` |
| `br` | `com.br` | `A10J1VAYUDTYRN` |

`autodetect_locale(domain)` scrapes `www.audible.{domain}` for other marketplaces. The API host is
`https://api.audible.{domain}`
([`client.py#L86-L102`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/client.py#L86-L102)).

### 1.5 Saving and loading auth

- `auth.to_dict() -> dict`
  ([`auth.py#L762`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/auth.py#L762))
  returns these keys: `website_cookies, adp_token, access_token, refresh_token, device_private_key,
  store_authentication_cookie, device_info, customer_info, expires, locale_code, with_username, activation_bytes`.
  Load it back with `Authenticator.from_dict(d)`. This is the right fit for a DB column. Encrypt the JSON yourself;
  the existing `AudibleAccount.encrypted_auth` model already plans Fernet. It holds a device private key and a
  refresh token, which is full account access until deregistered.
- File form (what audible-cli uses):

  ```python
  auth.to_file(filename=None, password=None, encryption="default", indent=4, set_default=True, **aes_kwargs)  # L786
  Authenticator.from_file(filename, password=None, locale=None, encryption=None, crypto_provider=None, **aes_kwargs)  # L424
  ```

  `encryption` is `False`, `"json"` (a JSON envelope with `salt`, `iv`, `ciphertext`, `info`) or `"bytes"`. On load
  the encryption is auto-detected (`aescipher.detect_file_encryption`). The cipher is AES-CBC with a key derived by
  PBKDF2-SHA256, 1000 iterations by default
  ([`aescipher.py#L144`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/aescipher.py#L144)).
  `AESCipher(password).to_dict(json_str)` / `.from_dict(d)` give the same encryption without a file. Fernet in
  Django is simpler, so I'd skip the library's crypto.

### 1.6 Auth modes and token refresh

`auth_flow` prefers **request signing** over bearer
([`auth.py#L615-L651`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/auth.py#L615-L651)).

- **Signing:** when `adp_token` and `device_private_key` exist, every request gets the headers `x-adp-token`,
  `x-adp-alg: SHA256withRSA:1.0` and `x-adp-signature`. This is an RSA signature over
  `method\npath\ndate\nbody\nadp_token`. **Signing never expires** (valid until deregistration), so normal API calls
  never need a token refresh.
- **Bearer:** used only if signing data is missing. `_apply_bearer_auth_flow` auto-refreshes when `access_token_expired`.
- Manual refresh: `auth.refresh_access_token(force=False)`
  ([`auth.py#L898`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/auth.py#L898)).
  It POSTs form data `{app_name, app_version, source_token=<refresh_token>, requested_token_type=access_token,
  source_token_type=refresh_token}` to `https://api.amazon.{domain}/auth/token` and updates `access_token` and
  `expires`. **The new token is valid for 60 minutes.** The module-level function is
  `refresh_access_token(refresh_token, domain, with_username=False) -> {"access_token", "expires"}`. There is also
  `async_refresh_access_token`.
- The access token is needed for `deregister_device()` (which refreshes first), `user_profile()`, and
  `set_website_cookies_for_country()`.
- After any task that may have refreshed, **write `auth.to_dict()` back to the DB**. `expires`/`access_token` change,
  and `activation_bytes` is cached there after `get_activation_bytes()`.
- Properties: `auth.access_token_expired`, `auth.access_token_expires` (timedelta), `auth.available_auth_modes`
  (`['signing','bearer','cookies']` subset).

---

## 2. Listing the library

```python
with audible.Client(auth=auth) as client:      # sync httpx; AsyncClient also exists
    lib = client.get("1.0/library", num_results=1000, page=1,
                     response_groups="contributors,media,product_attrs,product_desc,product_details,series,"
                                     "rating,customer_rights,listening_status,is_finished,percent_complete",
                     image_sizes="500,1215", sort_by="-PurchaseDate", status="Active")
    items = lib["items"]
```

`Client.get(path, response_callback=None, **kwargs)`. Any kwarg that isn't an httpx request arg is moved into
`params` (`_prepare_params`). Paths get `1.0/` prepended if they don't already have it, so `"library"` and
`"1.0/library"` are equivalent
([`client.py#L184-L307`](https://github.com/mkb79/Audible/blob/2460f9edff039d4b098d87be1fe7248381976bd7/src/audible/client.py#L184-L307)).
The constructor is `Client(auth, country_code=None, headers=None, timeout=10, response_callback=None, **httpx_kwargs)`.
Raise `timeout` for big libraries.

**Query params** (from `external_api.rst` `GET /1.0/library`):

- `num_results` (max 1000), `page`, `purchased_after` (RFC3339), `title`, `author`
- `sort_by` (`-PurchaseDate`, `Title`, `Length`, …), `status` (`Active` default / `Revoked`)
- `parent_asin` (children of multi-part books and podcasts), `include_pending`
- `image_sizes` (`1215,408,360,882,315,570,252,558,900,500`)
- `response_groups` (the full list is in the doc, see below)

**Pagination:** audible-cli `Library.from_api_full_sync`
([`CLI/src/audible_cli/models.py#L668`](https://github.com/mkb79/audible-cli/blob/274539eba80a63ddccb79a9ec4f59b2fe911e232/src/audible_cli/models.py#L668))
works like this:

1. Request `page=1&num_results=1000` with `response_callback` returning the raw `httpx.Response`.
2. Read the **`total-count` response header**.
3. Compute `pages = ceil(total/1000)` and fetch pages 2..n.

Simpler alternative: loop `page += 1` until `len(items) < num_results`. To get the header with the sync client, pass
`response_callback=lambda r: r` and then call `audible.client.convert_response_content(r)`.

**Response groups worth requesting.** These are all accepted per `external_api.rst`:
`contributors, customer_rights, media, price, product_attrs, product_desc, product_details, product_extended_attrs,
product_plan_details, product_plans, rating, sample, sku, series, reviews, ws4v, origin, relationships, review_attrs,
categories, badge_types, category_ladders, claim_code_url, in_wishlist, is_archived, is_downloaded, is_finished,
is_playable, is_removable, is_returnable, is_visible, listening_status, order_details, origin_asin, pdf_url,
percent_complete, periodicals, provided_review`.

An invalid group returns an error without saying which group was the problem.

| What we need | Field | Group (best evidence) |
|---|---|---|
| ASIN | `asin` | always |
| Title / subtitle | `title`, `subtitle` | `product_attrs` |
| Authors / narrators | `authors[]`, `narrators[]`, each `{asin, name}` | `contributors` (audible-cli joins `i["name"]`) |
| Runtime | `runtime_length_min` (int minutes) | `product_attrs` |
| Release / purchase date | `release_date` (`YYYY-MM-DD`), `purchase_date` (ISO) | `product_attrs` |
| Cover | `product_images` = dict `{"500": url, "1215": url, …}` keyed by the `image_sizes` you requested | `media` (+ `image_sizes` param) |
| Series | `series[]`, each `{asin, title, sequence}` (sequence is a string, e.g. `"3"`) | `series` |
| Description | `merchandising_summary` (HTML), `extended_product_description` | `product_desc` / `product_extended_attrs` |
| Publisher, language | `publisher_name`, `language` | `product_attrs` / `product_details` |
| Downloadable? | `customer_rights.is_consumable_offline` | `customer_rights` |
| AAX codecs | `available_codecs[]`, each `{name: "aax_44_128", enhanced_codec, ...}` | `media` (*inferred*: audible-cli's download command asks for `product_desc, media, product_attrs, relationships, series, customer_rights, pdf_url` and then reads `available_codecs`) |
| Multi-part / podcast | `content_delivery_type` (`SinglePartBook`, `MultiPartBook`, `AudioPart`, `Periodical`, `PodcastParent`), `content_type`, `relationships` | `product_attrs`, `relationships` |
| Progress | `listening_status = {is_finished, percent_complete, time_remaining_seconds, finished_at_timestamp}` | `listening_status` |
| PDF companion | `pdf_url` → download from `https://www.audible.{domain}/companion-file/{asin}` | `pdf_url` |

Sources for the field shapes:

- audible-cli `cmd_library.py export` (authors/narrators/series/rating/product_images/library_status handling)
- `models.py get_cover_url` (`product_images[str(res)]`)
- Recorded responses in `stewartjarod/omarchy-audible/fixtures/library-api.json` and `sync-library-progress.json`

The exact mapping of field to response group is **partly inferred**. Request a generous set and read the fields
defensively, since they can be `null`. Note that top-level `percent_complete`/`is_finished` can be `null` even when
`listening_status` has values (seen in the fixture), so prefer `listening_status`.

Single item: `GET 1.0/library/{asin}` takes the same `response_groups` and returns `{"item": {...}}`.

---

## 3. Downloading audio

There are two formats:

- **AAXC**: per-book key/IV in a "voucher", obtained through a license request. It works for basically every title,
  including Plus catalog and AYCE titles. This is what the current Audible apps use.
- **AAX** (legacy): one per-account key, the 4-byte "activation bytes". Not offered for every title.

audible-cli supports `--aax`, `--aaxc` and `--aax-fallback`. **I'd use AAXC as the primary path.**

### 3.1 License request (AAXC)

audible-cli `LibraryItem.get_license`
([`CLI/src/audible_cli/models.py#L387-L454`](https://github.com/mkb79/audible-cli/blob/274539eba80a63ddccb79a9ec4f59b2fe911e232/src/audible_cli/models.py#L387-L454)):

```python
body = {
    "supported_drm_types": ["Mpeg", "Adrm"],
    "quality": "High",                       # audible-cli only ever sends "High" or "Normal"
    "consumption_type": "Download",
    "response_groups": "last_position_heard,pdf_url,content_reference,chapter_info",
}
headers = {   # audible-cli sends these; whether they are *required* is unverified
    "X-Amzn-RequestId": secrets.token_hex(20).upper(),
    "X-ADP-SW": "37801821", "X-ADP-Transport": "WIFI", "X-ADP-LTO": "120",
    "X-Device-Type-Id": "A2CZJZGLK2JJVM", "device_idiom": "phone",
}
lr = client.post(f"content/{asin}/licenserequest", body=body, headers=headers)
```

- `Client.post(path, body, response_callback=None, **kwargs)`. `body` is sent as JSON.
- audible-cli's default `response_groups` is `"last_position_heard, pdf_url, content_reference"`. Adding
  `chapter_info` puts the chapter list in the same response, so you can skip the separate metadata call. audible-cli's
  decrypt plugin reads chapters from the saved voucher file first, falling back to `-chapters.json`.
- `external_api.rst` documents a newer variant. It uses
  `supported_media_features: {drm_types: ["Mpeg","Adrm"], codecs: ["mp4a.40.2","mp4a.40.42"], chapter_titles_type: "Tree"}`
  plus `tenant_id: "Audible"` and `spatial: false`, with quality values `Low|Normal|High|Extreme`. The library's own
  `examples/download_books_aaxc.py` uses `{"drm_type": "Adrm", "consumption_type": "Download", "quality": "Extreme"}`.
  **Uncertain** which form Amazon prefers today. The audible-cli body is the most heavily used, so start with it.

**Response handling** (`content_license` object):

- `status_code`: `"Denied"` comes with `message` and `license_denial_reasons[]` (`message`, `rejectionReason`,
  `validationType`). audible-cli raises `LicenseDenied`.
- `content_metadata.content_url.offline_url` is the download URL. If it's missing, audible-cli raises `NoDownloadUrl`.
- `content_metadata.content_reference.content_format`: if `"mpeg"` (case-insensitive) the file is a plain **MP3**
  with no DRM (typical for podcasts). Otherwise it's an `.aaxc`. Its `acr` is used by `PUT lastpositions`.
- `content_metadata.chapter_info` (if requested), `drm_type`, `license_response` (the **encrypted voucher**, base64),
  `refresh_date`, `removal_date`, `license_id`, `pdf_url`, `last_position_heard`.
- An item with `content_delivery_type == "MultiPartBook"` may fail with "please download individual parts". In that
  case list its children with `library?parent_asin={asin}` and license each part (audible-cli
  `_add_audioparts_to_queue`).

**Download:** a streaming GET of `offline_url`. audible-cli streams through the same signed `httpx` session with
`User-Agent: Audible/671 CFNetwork/1240.0.4 Darwin/20.6.0`
([`cmd_download.py#L49`](https://github.com/mkb79/audible-cli/blob/274539eba80a63ddccb79a9ec4f59b2fe911e232/src/audible_cli/cmds/cmd_download.py#L49)).
The library example uses plain `httpx.stream("GET", url, headers={"User-Agent": ...})` with no auth, because the URL
is pre-signed. audible-cli checks the response `Content-Type`:

- AAXC accepts `audio/aax`, `audio/vnd.audible.aax`, `audio/audible`, `audio/mp4`, `audio/mpeg`, `audio/mp3` and
  `audio/x-m4a` (`constants.py`).
- A `text/html` 200 response is an error page ("File Assembly error"). Don't save it as audio.

### 3.2 Chapter metadata endpoint

audible-cli `get_content_metadata`
([`models.py#L456`](https://github.com/mkb79/audible-cli/blob/274539eba80a63ddccb79a9ec4f59b2fe911e232/src/audible_cli/models.py#L456)):

```python
client.get(f"content/{asin}/metadata",
           response_groups="last_position_heard, content_reference, chapter_info",
           quality="High", drm_type="Adrm", chapter_titles_type="Tree")   # or "Flat"
```

The response is `content_metadata.chapter_info`:

```json
{"brandIntroDurationMs": 2043, "brandOutroDurationMs": 5061, "is_accurate": true, "runtime_length_ms": 41234567,
 "chapters": [{"title": "Chapter 1", "start_offset_ms": 0, "start_offset_sec": 0, "length_ms": 123456,
               "chapters": [ ...nested when chapter_titles_type=Tree... ]}]}
```

- Use `chapter_titles_type="Flat"` to avoid recursion. Music Assistant does this.
- `is_accurate: false` means don't trust the offsets (audible-cli skips the rebuild).
- The decrypt plugin flattens Tree chapters as parent followed by children
  ([`CLI/plugin_cmds/cmd_decrypt.py#L109-L235`](https://github.com/mkb79/audible-cli/blob/274539eba80a63ddccb79a9ec4f59b2fe911e232/plugin_cmds/cmd_decrypt.py#L109)).
- The intro/outro durations let you strip the "This is Audible" brand clips.

### 3.3 Decrypting the voucher → key / iv

This lives in the **`audible` package**, not audible-cli. audible-cli just imports it.

```python
# A/src/audible/aescipher.py#L471
def decrypt_voucher_from_licenserequest(auth: audible.Authenticator, license_response: dict[str, Any], *,
                                        crypto_provider=None) -> dict[str, Any]
```

The algorithm (`_decrypt_voucher`, L437):

1. `sha256(device_type + device_serial_number + customer_id + asin)`. `device_type` and `device_serial_number` come
   from `auth.device_info`, `customer_id` from `auth.customer_info["user_id"]`, and `asin` from
   `license_response["content_license"]["asin"]`.
2. `key = digest[:16]`, `iv = digest[16:]`.
3. AES-CBC-decrypt the base64 `license_response` with no padding, then strip `\x00`.
4. JSON-parse the result. If that fails, regex-extract `key`/`iv`.

The result is a dict with at least **`key`** and **`iv`**, both hex strings that go straight to ffmpeg.

**The voucher can only be decrypted with the same registered device's `device_info`/`customer_info`.** Store the
decrypted key/iv with the file (the model's `encrypted_drm` already does this). Don't rely on re-deriving it after a
re-registration.

```python
from audible.aescipher import decrypt_voucher_from_licenserequest
v = decrypt_voucher_from_licenserequest(auth, lr)
key, iv = v["key"], v["iv"]
```

### 3.4 AAX fallback and activation bytes

```python
# A/src/audible/activation_bytes.py#L176
def get_activation_bytes(auth, filename=None, extract=True) -> str | bytes
# method form, caches into auth.activation_bytes (saved by to_dict):
auth.get_activation_bytes(filename=None, extract=True, force_refresh=False) -> str   # auth.py#L976
```

- With signing auth it does `GET https://www.audible.com/license/token?player_manuf=Audible,iPhone&action=register&player_model=iPhone`
  (always the `.com` host). Otherwise it uses website cookies and a player token against
  `/license/licenseForCustomerToken`.
- It then extracts the 4 bytes from the last `0x238` bytes of the blob and returns **8 hex characters** (e.g.
  `"1a2b3c4d"`). These are per account and don't change, so fetch them once and store them.

AAX download URL. audible-cli uses `get_aax_url_old`
([`models.py#L299`](https://github.com/mkb79/audible-cli/blob/274539eba80a63ddccb79a9ec4f59b2fe911e232/src/audible_cli/models.py#L299)):

- Pick the codec from `available_codecs`: `AAX_44_128` for "high", `AAX_44_64` for "normal", or the best `aax_*`,
  and use its `enhanced_codec` value. If there is no codec, or `is_ayce` is set, raise `NotDownloadableAsAAX`. That
  is the trigger for falling back to AAXC.
- Send a **signed HEAD** to `https://cde-ta-g7g.amazon.com/FionaCDEServiceEngine/FSDownloadContent` with
  `type=AUDI&currentTransportMethod=WIFI&key={asin}&codec={enhanced_codec}`. Read the `Location` header and replace
  `cds.audible.com` with `cds.audible.{domain}`.
- Then stream-GET that URL. Do the HEAD through `client.session.head(...)` so the request is signed. Not following
  redirects is the point, since you need the `Location`.

### 3.5 ffmpeg decryption

ffmpeg's `mov` demuxer has the options `-activation_bytes`, `-audible_key`, `-audible_iv` and `-audible_fixed_key`.
I confirmed this locally with `ffmpeg -h demuxer=mov` on ffmpeg 9.0.2. audible-cli requires ffmpeg ≥ 4.4 for AAXC.
**These are input options and must come before `-i`.** The commands are in section 5.

---

## 4. Current listening position

**Primary endpoint:** `GET 1.0/annotations/lastpositions?asins=A,B,C`. It's documented in `external_api.rst#L739`
only as a query parameter. The response shape below is from recorded real responses in other projects
(stewartjarod/omarchy-audible `fixtures/sync-lastpositions.json`, Music Assistant `_fetch_last_position`).

```python
r = client.get("1.0/annotations/lastpositions", asins=",".join(asins))
```

```json
{"asin_last_position_heard_annots": [
   {"asin": "B0…", "last_position_heard": {"last_updated": "2025-08-28 19:24:46.771", "position_ms": 5255484, "status": "Exists"}},
   {"asin": "B0…", "last_position_heard": {"status": "DoesNotExist"}}],
 "response_groups": ["always-returned"]}
```

- The field is **`asin_last_position_heard_annots[].last_position_heard.position_ms`** (int, milliseconds).
- `status` is `Exists` or `DoesNotExist`. With `DoesNotExist`, `position_ms` is absent; treat it as 0.
- `last_updated` is `"YYYY-MM-DD HH:MM:SS.fff"`, with the timezone unspecified (probably UTC, **unverified**).
- **Batching:** other projects batch **25 ASINs per call**. lovettbarron/earworm's research says the parameter has a
  limit of 25 ASINs and 500 characters. That's secondary evidence, not documented by Audible, so keep batches ≤ 25.

Other sources of position or progress:

- The license request with `response_groups` containing `last_position_heard` returns
  `content_license.last_position_heard` (same `{position_ms, status, last_updated}` shape, per Music Assistant and
  `external_api.rst`). The same goes for the metadata endpoint (`last_position_heard` group).
- `POST 1.0/content/{asin}/playback-state` (documented in `external_api.rst`) returns `last_position_heard`.
- Library `response_groups=listening_status` returns `{percent_complete (float 0–100), is_finished,
  time_remaining_seconds, finished_at_timestamp}` per item. It's good for bulk progress bars in the library sync but
  has no millisecond position. `position ≈ runtime_length_min*60 - time_remaining_seconds` is an approximation.
- Writing a position back (not needed now): `PUT 1.0/lastpositions/{asin}` with body `{"acr": <from license>,
  "asin": asin, "position_ms": n}`.

**Recommendation:** use the library sync for `percent_complete`/`is_finished`/`time_remaining_seconds`, plus one
`annotations/lastpositions` call per 25 ASINs for `position_ms`.

---

## 5. ffmpeg / ffprobe commands

`$KEY`/`$IV` are the hex strings from the voucher. `$AB` is the 8-hex-char activation bytes. The flags go **before
`-i`**.

**Decrypt to M4B (lossless, no re-encode).** This is the recommended first step: decrypt once, then everything else
works on a plain file.

```bash
# AAXC
ffmpeg -v error -stats -y -audible_key "$KEY" -audible_iv "$IV" -i book.aaxc -map 0:a -c copy book.m4b
# AAX
ffmpeg -v error -stats -y -activation_bytes "$AB" -i book.aax -map 0:a -c copy book.m4b
```

- audible-cli's decrypt plugin uses `-c copy` without `-map`. It keeps the embedded cover too.
- Use `-map 0:a` if the cover stream causes problems for the target muxer. To keep the cover in m4b, map `0:v?`
  with `-c copy` and `-disposition:v attached_pic`.
- AAXC with `content_format=mpeg` is already MP3. Skip decryption.

**Replace chapters with the API's chapter list** (what audible-cli does when `--rebuild-chapters` is set):

1. Dump the metadata:
   `ffmpeg -audible_key K -audible_iv I -i book.aaxc -f ffmetadata meta.txt`
2. Rewrite the `[CHAPTER]` blocks (`TIMEBASE=1/1000`, `START`, `END`, `title`).
3. Remux:
   `ffmpeg -audible_key K -audible_iv I -i book.aaxc -i meta.txt -map_metadata 0 -map_chapters 1 -c copy book.m4b`
4. To strip the brand intro/outro, put the input options `-ss {intro}ms -t {runtime-intro-outro}ms` before the first `-i`.

**Read chapters:**

```bash
ffprobe -v error -print_format json -show_chapters book.m4b
# (works directly on encrypted input too: ffprobe -activation_bytes $AB ... / -audible_key $KEY -audible_iv $IV ...)
```

The output is `{"chapters":[{"id":0,"time_base":"1/44100","start":0,"start_time":"0.000000","end":176400,"end_time":"4.000000","tags":{"title":"…"}}]}`.
Use `start_time`/`end_time` (seconds, as strings). These embedded chapters are usually equivalent to the API's
`chapter_info`. The API list is the canonical source, and audible-cli uses it to fix inaccurate embedded chapters.

**Whole book to one MP3:**

```bash
ffmpeg -v error -stats -y -i book.m4b -map 0:a -c:a libmp3lame -q:a 4 -id3v2_version 3 book.mp3   # VBR ~165k; or -b:a 64k -ac 1 for speech
```

**Split into per-chapter MP3s.** I tested both options on a synthetic 3-chapter m4b with ffmpeg 9.0.2.

Option A: one ffmpeg per chapter, with input seeking on the **decrypted** m4b. This is accurate for AAC, fast, can run
in parallel, and sets per-file tags.

```bash
ffmpeg -v error -y -ss 4.000 -t 5.000 -i book.m4b -map 0:a -map_chapters -1 -map_metadata 0 \
  -metadata title="Chapter 1" -metadata track=2/3 -metadata album="Book Title" \
  -id3v2_version 3 -c:a libmp3lame -q:a 4 "002 - Chapter 1.mp3"
```

- `-ss` is the chapter start in seconds and `-t` its duration (`end - start`).
- `-map_chapters -1` stops the whole-book chapter list from being copied into every file.

Option B: a single decode pass with the segment muxer. This is the fastest. Tag titles afterwards, e.g. with `mutagen`,
because the segment muxer can't set per-segment titles.

```bash
ffmpeg -v error -y -i book.m4b -map 0:a -map_chapters -1 -c:a libmp3lame -q:a 4 \
  -f segment -segment_times 4.000,9.000 -reset_timestamps 1 "ch_%03d.mp3"
```

`-segment_times` is the comma-separated list of chapter **start** times excluding 0.

Avoid what audible-aax-to-mp3 does: re-reading and decrypting the encrypted AAX for every chapter with output-side
`-ss`. That decodes from the start of the file for every chapter, so the cost is O(chapters × length).

---

## 6. Does `artvandelay/audible-aax-to-mp3` add anything?

**No.** We should do it ourselves with ffmpeg. The repo, as of commit `8121ec2`:

- **Size and maintenance:** about 300 lines in total (`lib/converter.py` is 163). One commit (2025-09-09), 1 star,
  license `NOASSERTION`.
- **AAX only:** no AAXC support, so it can't handle titles that are AAXC-only.
- **Activation bytes:** obtained by shelling out to the separate `inAudible-NG/audible-activator` (Selenium, Firefox
  and geckodriver). The `audible` package already does this in one call (`auth.get_activation_bytes()`).
- **Conversion:** `ffprobe -activation_bytes AB -print_format json -show_chapters`, then for each chapter
  `ffmpeg -activation_bytes AB -i book.aax -vn -sn -dn -map a:0 -ss START -to END -map_metadata -1 -metadata title=… -c:a libmp3lame -q:a 2 NNN_title.mp3`.
  Decrypting and decoding the whole file again for each chapter with output seeking is slow (see section 5).
- **Extras:** a Flask upload page and a zip helper.
- **Nothing reusable:** no use of the API's chapter list, intro/outro handling, cover art, or tags beyond `title`.

The ideas are the same as section 5's commands. Section 5's versions are faster and also cover AAXC.

---

## 7. Recommended approach (for the Django/Celery app)

1. **Dependencies:** `audible[cryptography]==0.13.x` on Python 3.13/3.14. **Don't install `audible-cli` as a
   dependency.** It's a click CLI with no stable library API. Use its source as the reference implementation for
   requests, headers and edge cases.
2. **Connect account:** two views, as in section 1.3. Store the pending `{code_verifier, serial, locale}` encrypted on
   `AudibleAccount.pending_login`. On finish, `register()` → `Authenticator.from_dict` →
   `encrypted_auth = fernet(json(auth.to_dict()))`. Add a "Disconnect" action that calls `auth.deregister_device()`.
3. **Per Celery task:**

   ```python
   auth = Authenticator.from_dict(json.loads(decrypt(acc.encrypted_auth)))
   with audible.Client(auth, timeout=30) as c:
       ...
   ```

   Afterwards, re-save `auth.to_dict()` if it changed. Signing auth means no routine token refresh.
4. **Library sync task:** page through `1.0/library` (1000 per page, `total-count` header) with
   `contributors,media,product_attrs,product_desc,product_details,series,customer_rights,relationships,listening_status`
   and `image_sizes=500,1215`. Then call `annotations/lastpositions` in batches of 25 for `position_ms`.
5. **Download task:**
   - Request the license with `chapter_info` in the response groups.
   - Check `status_code`.
   - Call `decrypt_voucher_from_licenserequest` and store the key/iv encrypted.
   - Store `chapter_info` in `Book.chapters`.
   - Stream `offline_url` to disk and validate `Content-Type`.
   - Handle MultiPartBook by downloading its children.
   - Fall back to AAX (activation bytes) only if the license is denied or AAXC fails.
6. **Convert task:**
   - Decrypt once to m4b with `-c copy`.
   - Split with Option A (one process per chapter, can run in parallel, sets tags) or Option B (single pass plus
     tagging).
   - Use the API chapter offsets when `is_accurate` is true, else `ffprobe -show_chapters`.
   - For speech, something like `-b:a 64k -ac 1` or `-q:a 6` keeps files small.

## 8. Open questions / unverified

- How long the `openid.oa2.authorization_code` and a pending `code_verifier` stay valid. Not documented anywhere I
  found.
- Whether the extra `X-ADP-*` headers on `licenserequest` are required. audible-cli sends them; the library example
  doesn't.
- Which licenserequest body Amazon prefers today: the `supported_drm_types` form (audible-cli) or the
  `supported_media_features` form (current-app variant in `external_api.rst`). Also whether `quality: "Extreme"` gives
  higher bitrate than `"High"`.
- The exact field-to-response-group mapping in section 2 is partly inferred. Request generous groups and read
  defensively.
- The 25-ASIN / 500-character limit on `annotations/lastpositions` comes from third-party observation.
- The timezone of `last_position_heard.last_updated`.
- All Audible endpoints are unofficial and reverse-engineered, and can change without notice. Pin the `audible`
  version, but expect to have to bump it when Amazon changes the device profile (as happened in 0.13.1).
