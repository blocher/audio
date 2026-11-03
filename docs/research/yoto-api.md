# Yoto Developer API: reference for a Django backend integration

Researched 2026-11-02. Primary sources: the yoto.dev guides, the yoto.dev API reference (its embedded OpenAPI spec), Yoto's own GitHub repos (`yotoplay/examples`, `yotoplay/yoto-sdk`, `yotoplay/twine-to-yoto`) and Yoto's support site. Community code (`xkjq/yoto-up`, `mylacc/yoto-audiobookshelf-bridge`, `cdnninja/yoto_api`) was used only to fill gaps, and is marked **[community]** where it is the only source.

Legend: **[UNCERTAIN]** means the sources disagree or say nothing, so check against the live API.

---

## 0. Hosts and conventions

| What | Value | Source |
|---|---|---|
| API base | `https://api.yotoplay.com` | [API reference](https://yoto.dev/api/) |
| Auth server (Auth0 tenant) | `https://login.yotoplay.com` | [Browser auth](https://yoto.dev/authentication/browser-auth/) |
| OAuth `audience` | `https://api.yotoplay.com` | [Browser auth](https://yoto.dev/authentication/browser-auth/), [GET /authorize](https://yoto.dev/api/authentication/get-authorize) |
| Labs (TTS) API | `https://labs.api.yotoplay.com` | [Labs TTS](https://yoto.dev/myo/labs-tts/) |
| Developer dashboard | `https://dashboard.yoto.dev/` | [Start here](https://yoto.dev/get-started/start-here/) |
| Auth header | `Authorization: Bearer <access_token>` | every guide |
| API error shape | `{"error": {"code": "bad-request" \| "not-found" \| "forbidden", "message": "..."}}` | [Create/Update content](https://yoto.dev/api/content/createOrUpdateContent), [Delete content](https://yoto.dev/api/content/deleteContent) |
| OAuth error shape | `{"error": "invalid_grant", "error_description": "..."}` | [POST /oauth/token](https://yoto.dev/api/authentication/post-oauth-token) |

The API sits behind AWS API Gateway and CloudFront: the reference's example response headers include `x-amz-apigw-id` and `Via: ... cloudfront.net`. User IDs look like `auth0|...`.

---

## 1. Authentication

### 1.1 Supported flows

| Flow | Status | Use for |
|---|---|---|
| **Authorization Code, confidential client** (`client_secret`, no PKCE needed) | Supported | **Recommended for Django.** The secret stays on the server. See the [Glossary](https://yoto.dev/get-started/glossary/) and the [Next.js example](https://github.com/yotoplay/examples/tree/main/next.js). |
| Authorization Code + PKCE, public client | Supported, and the documented path for browser, CLI and desktop apps | Also works from a server. CLI guides use the loopback redirect `http://127.0.0.1:8787/callback`. See [Headless/CLI auth](https://yoto.dev/authentication/headless-cli-auth/). |
| Device Authorization (`POST /oauth/device/code`, grant `urn:ietf:params:oauth:grant-type:device_code`) | **Deprecated**: "Do not use it for new apps" | Still listed in the [API reference](https://yoto.dev/api/authentication/post-oauth-device-code). See [Device code migration](https://yoto.dev/authentication/device-code-migration/). **[community]** says it is refused for new clients ([yoto-audiobookshelf-bridge](https://github.com/mylacc/yoto-audiobookshelf-bridge/blob/main/yotobridge/yoto.py)). |

Public and confidential clients differ in whether the app can store a `client_secret` securely. "Confidential clients will store the client secret on a server … and as a result don't require PKCE" ([Glossary](https://yoto.dev/get-started/glossary/)). The token endpoint schema marks `client_secret` optional and `code_verifier` optional, so a confidential client may send both. That combination is untested.

### 1.2 Registering an app / getting a client_id

1. Sign in at https://dashboard.yoto.dev/ and create an app. You choose **public** or **confidential**, and you get a `client_id` (plus a `client_secret` for confidential) ([Start here](https://yoto.dev/get-started/start-here/), [Glossary](https://yoto.dev/get-started/glossary/)).
2. Register every `redirect_uri` exactly. Wildcards such as `https://*.netlify.app/api/auth/callback/yoto` are allowed ([Headless/CLI auth](https://yoto.dev/authentication/headless-cli-auth/)). For local dev you could register something like `http://localhost:8000/yoto/callback/`.
3. New apps start **unverified**. Users see a warning on the consent screen along with the developer's email, but the app works fully, and verification is not required for personal or small-scale use ([Verification status](https://yoto.dev/get-started/verification-status/)). This is fine for 1–2 users.
4. **[UNCERTAIN / community]** The dashboard may also have per-app scope checkboxes that must match what you request ("The Yoto app must have it ticked (dashboard.yoto.dev)", [yoto-audiobookshelf-bridge](https://github.com/mylacc/yoto-audiobookshelf-bridge/blob/main/yotobridge/yoto.py)). Check the dashboard when you create the app.

### 1.3 Scopes

From [API Scopes](https://yoto.dev/authentication/scopes/):

| Scope | Grants |
|---|---|
| `user:content:view` | View MYO content |
| `user:icons:manage` | View, upload and edit custom icons |
| `user:content:manage` | View, create, edit and delete MYO content. **Includes `user:content:view` and `user:icons:manage`.** |
| `family:library:view` / `family:library:manage` | Family card library |
| `family:devices:view` / `family:devices:manage` / `family:devices:control` | Players. Apps using `manage` or `control` cannot be verified (personal use is fine). |
| `family:view` | Family info, members' emails |
| `offline_access` | **Required to get a refresh token** |
| `profile` | Name and email |

**For this app, request `offline_access user:content:manage`.** That covers upload URLs, content CRUD, cover images and icons. Add `profile` if you want the user's name and email from the `id_token`.

Required scopes per endpoint, from the API reference:
- `user:content:manage`: `GET /media/transcode/audio/uploadUrl`, `POST /content`, `DELETE /content/{cardId}`, `POST /media/coverImage/user/me/upload`.
- `user:content:view`: `GET /content/mine`, `GET /content/{cardId}`.
- `user:icons:manage`: the icon endpoints, including the public icon list.

### 1.4 Step 1: authorize redirect

`GET https://login.yotoplay.com/authorize` takes these query parameters ([API reference](https://yoto.dev/api/authentication/get-authorize)):

| Param | Value |
|---|---|
| `audience` | `https://api.yotoplay.com` (required) |
| `scope` | `offline_access user:content:manage` (required, space-separated) |
| `response_type` | `code` |
| `client_id` | your client id |
| `redirect_uri` | must match a registered URL |
| `state` | **listed as Required** in the reference (CSRF). The guides omit it, but send it anyway. |
| `code_challenge`, `code_challenge_method=S256` | only for a public client using PKCE |
| optional | `nonce`, `prompt` (`none`/`login`/`consent`/`select_account`), `max_age` |

Example (confidential client):

```
https://login.yotoplay.com/authorize?audience=https%3A%2F%2Fapi.yotoplay.com&scope=offline_access%20user%3Acontent%3Amanage&response_type=code&client_id=CLIENT_ID&redirect_uri=https%3A%2F%2Fexample.com%2Fyoto%2Fcallback&state=RANDOM
```

Yoto redirects to `redirect_uri?code=...&state=...`. On failure it sends `?error=...&error_description=...` (error codes are in the reference; the [yoto-sdk](https://github.com/yotoplay/yoto-sdk/blob/main/src/base/YotoBaseSdk.ts) reads them).

### 1.5 Step 2: code exchange

`POST https://login.yotoplay.com/oauth/token` with `Content-Type: application/x-www-form-urlencoded` ([API reference](https://yoto.dev/api/authentication/post-oauth-token)).

Confidential client body ([Next.js example](https://github.com/yotoplay/examples/blob/main/next.js/src/app/api/auth/callback/route.js)):

```
grant_type=authorization_code
client_id=CLIENT_ID
client_secret=CLIENT_SECRET
code=AUTH_CODE
redirect_uri=https://example.com/yoto/callback   # identical to step 1
```

A PKCE public client sends `code_verifier=...` instead of `client_secret`.

200 response (schema from the reference; `access_token`, `token_type` and `expires_in` are required):

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "v1.M...",
  "scope": "offline_access user:content:manage",
  "id_token": "eyJ...",
  "expires_at": 1767312000
}
```

`expires_in: 86400` is illustrative only. The guides say access tokens are "usually valid for a few hours" ([Auth overview](https://yoto.dev/authentication/auth/)). Read `expires_in`, or the JWT `exp` claim, rather than hard-coding a lifetime. Error responses are 400 (`invalid_grant`, `invalid_request`, …) and 401 (`invalid_client`).

### 1.6 Refresh

Same endpoint, form-encoded:

```
grant_type=refresh_token
client_id=CLIENT_ID
client_secret=CLIENT_SECRET     # confidential clients; "optional for public clients"
refresh_token=CURRENT_REFRESH_TOKEN
# optional: scope=...
```

**Refresh tokens are single-use and rotate.** Every refresh returns a new `refresh_token` and invalidates the old one, so "Always replace your old tokens with the new ones" ([Browser auth](https://yoto.dev/authentication/browser-auth/), [Headless auth](https://yoto.dev/authentication/headless-cli-auth/)).

What this means for Django:
- Persist the new refresh token in the database atomically, before you use the new access token.
- Serialize refreshes per user (for example `select_for_update` or a lock). Two concurrent refreshes with the same token will make one of them fail with `invalid_grant`. The community library [cdnninja/yoto_api](https://github.com/cdnninja/yoto_api) has a `test_concurrent_refresh.py` for exactly this case.
- Refresh proactively. Yoto's example refreshes once `exp` is within 30 seconds of now ([Headless auth](https://yoto.dev/authentication/headless-cli-auth/)).
- **[community]** Some clients also send `audience=https://api.yotoplay.com` on refresh. It is not in the documented schema.
- **[UNCERTAIN]** Refresh-token idle or absolute lifetime is not documented. Handle `invalid_grant` by asking the user to reconnect.

Logout, if needed: `https://login.yotoplay.com/v2/logout?client_id=...&returnTo=...` ([yoto-sdk](https://github.com/yotoplay/yoto-sdk/blob/main/src/base/YotoBaseSdk.ts)).

---

## 2. Uploading audio

Sources: [Uploading to cards](https://yoto.dev/myo/uploading-to-cards/), [GET uploadUrl reference](https://yoto.dev/api/media/getAnUploadUrl), [yotoplay/examples upload.js](https://github.com/yotoplay/examples/blob/main/vanilla-js-html/src/upload.js), [yotoplay/yoto-sdk mediaApi.ts](https://github.com/yotoplay/yoto-sdk/blob/main/src/api/mediaApi.ts), [yotoplay/twine-to-yoto](https://github.com/yotoplay/twine-to-yoto/blob/main/lib/apis/api.yoto.ts).

### 2.1 Get a signed upload URL

```
GET https://api.yotoplay.com/media/transcode/audio/uploadUrl?sha256=<hex sha256 of source file>&filename=<optional name>
Authorization: Bearer <token>
Accept: application/json
```

- `sha256` is optional in practice: the guide's example omits it. When you send it, Yoto deduplicates. If a file with that checksum already exists, the response has `"uploadUrl": null` and you **skip the PUT** and go straight to polling with the `uploadId`. Yoto also hashes the uploaded file and compares the two hashes to confirm the upload.
- `filename` is optional.

Response (two documented variants):

```json
{ "upload": { "uploadId": "-JTCEUt18dYMVDUx_8Ncy",
              "uploadUrl": "https://yoto-media-api-...s3.eu-west-2.amazonaws.com/...?X-Amz-Algorithm=AWS4-HMAC-SHA256&...&X-Amz-Expires=900&X-Amz-SignedHeaders=host&x-id=PutObject" } }
```
```json
{ "upload": { "uploadId": "zK3NQ1r-P7mQd9IjOKVFjlWnYAuGn3nHWTJSejljJcM", "uploadUrl": null } }
```

The signed URL is an S3 presigned PutObject URL. The documented example has `X-Amz-Expires=900`, so **PUT within about 15 minutes**.

### 2.2 PUT the file

```
PUT <uploadUrl>
Content-Type: audio/mpeg          # guide: "match the type of your audio file"
<raw file bytes>
```

Do **not** send the `Authorization` header to S3. The guide sets `Content-Type` to the file's MIME type, while the official SDK and twine-to-yoto always send `audio/mpeg`. Because `X-Amz-SignedHeaders=host`, Content-Type is not part of the signature, so either should work. That last point is inferred from the signature, not documented. Use a long timeout: community code uses 300–1800 s for large files.

### 2.3 Poll for transcoding

```
GET https://api.yotoplay.com/media/upload/{uploadId}/transcoded?loudnorm=false
Authorization: Bearer <token>
```

This endpoint is used in the official guide and SDK but **is not in the API reference index**.

- Completion signal: the response contains `transcode.transcodedSha256`.
- Query params:
  - `loudnorm` (`true`/`false`): loudness normalisation. All examples use `false`.
  - `preset`: used by first-party twine-to-yoto, otherwise undocumented. Values: `auto`, `music`, `music_compressed`, `mixed_compressed`, `speech_compressed`, `longform_compressed`, `compression_minimal|low|medium|high|maximum` ([transcode.ts](https://github.com/yotoplay/twine-to-yoto/blob/main/lib/types/transcode.ts)). **[UNCERTAIN]** what each preset does.

Completed response. Field names come from first-party [twine-to-yoto `TranscodeResponse`](https://github.com/yotoplay/twine-to-yoto/blob/main/lib/types/transcode.ts); the values are illustrative:

```json
{
  "transcode": {
    "uploadId": "-JTCEUt18dYMVDUx_8Ncy",
    "uploadFilename": "story.mp3",
    "uploadSha256": "<sha256 of source>",
    "transcodedAt": "2026-11-02T10:00:00.000Z",
    "transcodedSha256": "ZCLKqoOhYCsXwwANZyIoaKSPHO8np9ohLD36dtGfjQE",
    "transcodedInfo": {
      "duration": 420,
      "fileSize": 1536000,
      "format": "aac",
      "codec": "aac",
      "sampleRate": 44100,
      "channels": "stereo",
      "bitrate": 96000,
      "metadata": { "title": "Story title from ID3 tags" }
    }
  }
}
```

- `duration` is in seconds and `fileSize` is in bytes (track schema).
- `transcodedInfo.metadata.title` is used by the guide as the default chapter title.
- **[UNCERTAIN] `channels` type.** twine-to-yoto types it as a string, the content schema enum is `"stereo" | "mono"`, the API reference example uses `"mono"`, but the guide's example track shows `"channels": 2`. yoto-up's model accepts `"stereo" | "mono" | 1 | 2`. **Pass `transcodedInfo.channels` through verbatim**, which is what every example does.
- **[community]** While transcoding is in progress the endpoint may answer with status ≥ 202 and `transcode.progress.percent` ([yoto-up](https://github.com/xkjq/yoto-up/blob/main/src/yoto_up/yoto_api.py)). Treat any response without `transcodedSha256` as not ready.

**Timing.** The guide polls 30 × 500 ms, about 15 s. That only suits short clips. **[community]** reports long files taking 1–2 minutes, and occasionally a 2 h track never finishing within 15 minutes; the bridge's fix is to give up after 900 s and re-upload, up to 3 tries ([yoto-audiobookshelf-bridge](https://github.com/mylacc/yoto-audiobookshelf-bridge/blob/main/yotobridge/yoto.py)). twine-to-yoto polls every 5 s. Run this in a background task with polling every 2–5 s and a timeout of around 15 minutes.

### 2.4 Resulting track URL

```
trackUrl = "yoto:#" + transcode.transcodedSha256      // e.g. "yoto:#ZCLKqoOhYCsXwwANZyIoaKSPHO8np9ohLD36dtGfjQE"
```

The value after `#` is a 43-character URL-safe base64 SHA-256, not hex. Copy `format`, `duration`, `fileSize` and `channels` from `transcodedInfo` into the track.

---

## 3. Playlist ("card") content: create, update, list, get, delete

Sources: [How playlists work](https://yoto.dev/myo/how-playlists-work/), [Card content schema](https://yoto.dev/reference/card-content-schema/), [POST /content reference](https://yoto.dev/api/content/createOrUpdateContent).

### 3.1 Create or update: `POST /content`

```
POST https://api.yotoplay.com/content
Authorization: Bearer <token>
Content-Type: application/json
```

- **No `cardId` creates** a new playlist, and the server generates the `cardId`. **With `cardId` it overwrites** that card's content entirely, so this is a full replace, not a patch.
- To edit, `GET /content/{cardId}`, modify the `card` object, and POST it back. The official [upload.js](https://github.com/yotoplay/examples/blob/main/vanilla-js-html/src/upload.js) does exactly this.
- `cardId` matches `^[a-zA-Z0-9]+$`, exactly 5 characters.
- POSTing the `cardId` of a deleted card returns 400 `"Deleted card cannot be restored"`.
- **[community]** Overwriting by `cardId` keeps the physical MYO card link: the bridge repurposes an existing linked card this way.

Full example body. The structure follows the guide; this example adds a second chapter and a cover:

```json
{
  "cardId": "31yYU",
  "title": "Bedtime Stories",
  "content": {
    "playbackType": "linear",
    "config": { "resumeTimeout": 2592000, "autoadvance": "next" },
    "chapters": [
      {
        "key": "01",
        "title": "The Friendly Dragon",
        "overlayLabel": "1",
        "display": { "icon16x16": "yoto:#AjJaUh665wfnb72_y5uQ3M0w3JtobwIVfGua_A_j6i8" },
        "tracks": [
          {
            "key": "01",
            "title": "The Friendly Dragon",
            "trackUrl": "yoto:#ZCLKqoOhYCsXwwANZyIoaKSPHO8np9ohLD36dtGfjQE",
            "type": "audio",
            "format": "aac",
            "duration": 420,
            "fileSize": 1536000,
            "channels": "stereo",
            "overlayLabel": "1",
            "display": { "icon16x16": "yoto:#AjJaUh665wfnb72_y5uQ3M0w3JtobwIVfGua_A_j6i8" }
          }
        ]
      },
      {
        "key": "02",
        "title": "Moon Song",
        "overlayLabel": "2",
        "display": { "icon16x16": "yoto:#GAvCuUCyEJhyYiZ6fJFfIBHkyblyHBvTlhsz4UantDM" },
        "tracks": [
          { "key": "01", "title": "Moon Song", "trackUrl": "yoto:#8jXjCtTB3pgrNEauEd3gN61P5Oza65RjPZjCmM7qGsk",
            "type": "audio", "format": "aac", "duration": 180, "fileSize": 700000, "channels": "stereo", "overlayLabel": "2" }
        ]
      }
    ]
  },
  "metadata": {
    "description": "Two bedtime stories",
    "cover": { "imageL": "https://card-content.aws.fooropa.com/.../pub/uiM3MMWgQkG_zdd_EYHd93Z2OQSH5Hn069wDGdWANMc" },
    "media": { "duration": 600, "fileSize": 2236000, "readableFileSize": 2.1 }
  }
}
```

Response (200):

```json
{ "card": { "_id": "676016ea43bedbaa54a70549", "cardId": "31yYU", "title": "Bedtime Stories",
            "content": { "chapters": [ ... ], "config": { "resumeTimeout": 2592000 }, "playbackType": "linear" },
            "metadata": { ... }, "createdAt": "...", "updatedAt": "...", "userId": "auth0|..." } }
```

**Field reference** ([Card content schema](https://yoto.dev/reference/card-content-schema/), plus the zod schema in [How playlists work](https://yoto.dev/myo/how-playlists-work/)):

- **Top level**
  - `title` (required, 1–140 characters).
  - `cardId` (5 alphanumeric characters, only for updates).
  - `content`, `metadata`.
  - `slug`, `createdAt` and `updatedAt` are optional.
- **content**
  - `chapters` (required array).
  - `playbackType`: `linear` or `interactive`.
  - `config.autoadvance`: `next`, `repeat` or `none`.
  - `config.resumeTimeout`: seconds, default 2592000 (30 days).
  - `config.onlineOnly`: bool.
  - `config.shuffle`: `[{start, end, limit}]`, 0-based inclusive chapter indices. Works on players only ([Shuffle](https://yoto.dev/myo/how-shuffle-works/)).
- **chapter**
  - Required: `key`, `title`, `tracks`, `display` (`{icon16x16}`). The [Using icons](https://yoto.dev/icons/using-icons/) guide says "Each chapter must have a `display` property", and tracks fall back to their chapter's icon.
  - Optional: `overlayLabel`, `duration`, `fileSize`, `availableFrom`, `ambient`, `defaultTrackDisplay`, `defaultTrackAmbient`.
- **track**
  - Required: `key`, `title`, `trackUrl`, `type`, `format`, `duration` (s), `fileSize` (bytes).
  - `type` is `audio` (uploaded, `yoto:#...`) or `stream` (an HTTP URL fetched at play time; [Streaming](https://yoto.dev/myo/streaming-tracks/)). Labs adds `elevenlabs`.
  - `format` is one of `mp3`, `aac`, `alac`, `flac`, `pcm_s16le`, `opus`, `ogg`, `x-m4a`, `wav`, `aiff`, `mpeg`, or `""`. The schema says opus or mp3 are preferred.
  - Optional: `overlayLabel` (the number shown in the app), `channels`, `display` (`{icon16x16}` or `{iconUrl16x16}`), `uid`, `events` (`onEnd`/`onLhb`/`onRhb` with `cmd` set to `stop`, `repeat` or `goto`).
- **metadata**
  - `media.duration`: total seconds; the schema marks it required inside `media`.
  - `media.fileSize`: total bytes; also required inside `media`.
  - `cover.imageL`: cover image URL.
  - `description`, `author`, `category` (`none`, `stories`, `music`, `radio`, `podcast`, `sfx`, `activities` or `alarms`), `languages` (BCP47), `minAge`, `maxAge`, and so on.
  - `readableFileSize` (MB) is used by the guide but is not in the schema.
- **[UNCERTAIN] Required fields.** The schema table marks track `uid` and `display`, and chapter `defaultTrackDisplay` and `defaultTrackAmbient`, as Required. The zod schema makes them optional or nullable, and every official example omits them. Omit them, or send `null`.
- **Keys.** The guides use `"01"`, `"02"` and so on. The reference example uses random strings (`"PmeUAfNAu"`). Any unique string per level appears fine.
- **[UNCERTAIN] Undocumented create options.**
  - The official SDK sends `POST /content?skipMediaFileCheck=true` by default ([contentApi.ts](https://github.com/yotoplay/yoto-sdk/blob/main/src/api/contentApi.ts)).
  - twine-to-yoto posts to `POST /content/bulk` ([api.yoto.ts](https://github.com/yotoplay/twine-to-yoto/blob/main/lib/apis/api.yoto.ts)).
  - Neither is documented. Plain `POST /content` is the documented path.

**Linking to a physical card.** The API creates a playlist in the user's library. Linking it to a physical MYO card happens in the Yoto app or on the player ("Link to a Card"). No documented endpoint does this ([Uploading to cards](https://yoto.dev/myo/uploading-to-cards/), [Support: add MP3s](https://support.yotoplay.com/en_gb/how-to-add-your-own-mp3-files-to-a-yoto-card-rJl2utiQfe)).

### 3.2 List user's cards: `GET /content/mine`

```
GET https://api.yotoplay.com/content/mine?showdeleted=false
```

The response is `{"cards": [ {cardId, title, content: {config, editSettings, ...}, metadata: {cover: {imageL}, media: {duration, fileSize, hasStreams}, ...}, createdAt, updatedAt, deleted, ...} ]}`. **Chapters are not included**; use `GET /content/{cardId}` for those ([reference](https://yoto.dev/api/content/getUserSMyoContent)).

### 3.3 Get one: `GET /content/{cardId}`

The response is `{"card": {...}}` with full chapters. It returns 404 if you don't own the card or lack a viewer or editor role. Optional query parameters ([reference](https://yoto.dev/api/content/getContent)):
- `timezone` (affects podcasts only).
- `playable=true&signingType=s3` returns playable signed URLs.

The SDK also uses `GET /card/{cardId}/media/{mediaId}` to get a signed media URL ([mediaApi.ts](https://github.com/yotoplay/yoto-sdk/blob/main/src/api/mediaApi.ts)). That endpoint is not documented.

### 3.4 Delete: `DELETE /content/{cardId}`

The response is `{"status": "ok"}`. It returns 404 `{"error":{"code":"not-found","message":"Card abc123 does not exist."}}` if the card is not the caller's own MYO card ([reference](https://yoto.dev/api/content/deleteContent)). Deleted cards remain visible with `showdeleted=true` and cannot be restored through POST.

---

## 4. Cover images and icons

### 4.1 Cover image: `POST /media/coverImage/user/me/upload`

Sources: [guide](https://yoto.dev/myo/uploading-cover-images/), [reference](https://yoto.dev/api/media/uploadCoverImage). Scope: `user:content:manage`.

```
POST https://api.yotoplay.com/media/coverImage/user/me/upload?autoconvert=true&coverType=default
Authorization: Bearer <token>
Content-Type: image/jpeg            # or image/png
<raw image bytes>                   # NOT multipart
```

- Query params:
  - `autoconvert`: all lowercase, unlike the icon endpoint. `true` makes Yoto resize the image to cover dimensions.
  - `coverType`: `default`.
  - `filename`: optional.
  - `imageUrl`: an alternative to a body; Yoto fetches the image from that URL.
- Response:
  ```json
  {"coverImage": {"mediaId": "uiM3MMWgQkG_zdd_EYHd93Z2OQSH5Hn069wDGdWANMc",
                  "mediaUrl": "https://card-content.aws.fooropa.com/1bErAD2CBDPwN88jdjBO7aVSR1OGL5DOq05fyz6PioCs~/pub/uiM3MMWgQkG_zdd_EYHd93Z2OQSH5Hn069wDGdWANMc"}}
  ```
- Use it by setting `metadata.cover.imageL = coverImage.mediaUrl`.
- Errors:
  - 400 `"A binary image file body or imageUrl param is required"`.
  - 403 `"Access to media account denied"`.
- **[UNCERTAIN]** Target cover dimensions, the other `coverType` values and the maximum image size are not documented.

### 4.2 Custom icon: `POST /media/displayIcons/user/me/upload`

Sources: [guide](https://yoto.dev/icons/uploading-icons/), [reference](https://yoto.dev/api/icons/uploadCustomIcon). Scope: `user:icons:manage`.

```
POST https://api.yotoplay.com/media/displayIcons/user/me/upload?autoConvert=true&filename=my-icon
Authorization: Bearer <token>
Content-Type: image/png             # or image/gif
<raw image bytes>
```

- `autoConvert=true` resizes the image to 16×16. With `false`, the image must already be exactly 16×16 PNG or GIF.
- **Animated GIFs must use `autoConvert=false`.** Conversion flattens them to a static PNG ([Animated GIFs](https://yoto.dev/icons/uploading-animated-gifs/)).
- **[UNCERTAIN] Body format.** The guide's first snippet sends multipart `FormData` with a field named `file`. The guide's complete example and the first-party twine-to-yoto send raw bytes with a Content-Type. Prefer raw bytes.
- Response:
  ```json
  {"displayIcon": {"mediaId": "zbFJyjjwsIkOch_Ym8qy0dCU20oDODkBz_YEylgG6gg", "userId": "auth0|...",
                   "displayIconId": "688237b96dbfcfbe1b594350",
                   "url": "https://media-secure-v2.../icons/zbFJ...", "new": true}}
  ```
  `new: false` presumably means a duplicate of an existing icon.
- Use it as `display.icon16x16 = "yoto:#" + mediaId` on a chapter and/or a track. The value must match `^yoto:#[a-zA-Z0-9_-]{43}$`.

### 4.3 Listing icons

- **Your icons:** `GET /media/displayIcons/user/me` returns `{"displayIcons": [{mediaId, displayIconId, url, public:false, createdAt, userId}]}` ([reference](https://yoto.dev/api/icons/getUserIcons)).
- **Public Yoto icon library:** `GET /media/displayIcons/user/yoto` returns `{"displayIcons": [{mediaId, displayIconId, title, publicTags: [...], url, public:true, new:true, userId:"yoto", createdAt}]}` ([reference](https://yoto.dev/api/icons/getPublicIcons)). It needs `user:icons:manage`. Reference a public icon as `yoto:#<mediaId>`.
- A static list of public icon IDs is on [Using icons](https://yoto.dev/icons/using-icons/), for example Moon `yoto:#AjJaUh665wfnb72_y5uQ3M0w3JtobwIVfGua_A_j6i8` and Music notes `yoto:#_WWpLHoOj6iqeREcGkJnGlsis2QSF6znM0UPFdXTjf8`. The icon ID is the icon's SHA-256 hash.

### 4.4 Dynamic (URL) icons

Instead of `icon16x16`, set `display.iconUrl16x16` to a URL that returns a **16×16 PNG, 32-bit RGBA with alpha** ([Dynamic icons](https://yoto.dev/icons/dynamic-icons/)).

---

## 5. Limits

| Limit | Value | Source |
|---|---|---|
| Tracks per card | **100** | [Yoto support](https://support.yotoplay.com/en_gb/how-much-audio-fits-on-a-make-your-own-card-r1ssdFimfl) |
| Single track | **100 MB / 60 minutes** max | same |
| Whole card | **500 MB / 5 hours** max total audio | same |
| Card title | 1–140 characters | [Card content schema](https://yoto.dev/reference/card-content-schema/) |
| Labs TTS text | 3000 characters per track | [Labs TTS](https://yoto.dev/myo/labs-tts/) |
| Signed upload URL lifetime | about 900 s (from the documented example URL) | [uploadUrl reference](https://yoto.dev/api/media/getAnUploadUrl) |
| Icons | 16×16 PNG/GIF (or auto-converted) | [Uploading icons](https://yoto.dev/icons/uploading-icons/) |

**[UNCERTAIN]** The support page states the size and duration limits for app-created playlists. Whether the API enforces them, and with what error, is undocumented. Also unclear is whether "100 MB" applies to the source upload or to the transcoded file, and whether you can exceed it via streams. Validate on your side before uploading.

**Supported input formats [UNCERTAIN].** No first-party page lists accepted upload formats. Audio is transcoded server-side, and the transcoded `format` is typically `aac`, `mp3` or `opus`. The content schema's `format` enum (`mp3`, `aac`, `alac`, `flac`, `pcm_s16le`, `opus`, `ogg`, `x-m4a`, `wav`, `aiff`, `mpeg`) suggests wide support. Yoto's consumer pages explicitly mention MP3 and AAC/M4A ([yotoplay.com/myo](https://yotoplay.com/myo)). MP3 and M4A are the safe choices; test the others.

**Rate limits [UNCERTAIN]:** none are published. The [API Terms](https://yoto.dev/reference/terms-and-conditions/) reserve the right to impose rate limits, quotas or concurrency limits "at any time, with or without notice", and forbid circumventing them. They also require traffic proportionate to genuine end-user use; scheduled sync is allowed if proportionate. Practical guidance:
- The official SDK retries network errors and 5xx responses 5 times with exponential backoff ([YotoBaseSdk.ts](https://github.com/yotoplay/yoto-sdk/blob/main/src/base/YotoBaseSdk.ts)).
- Handle 429 / `Retry-After` defensively even though no source documents it.
- Keep upload concurrency low; yoto-up defaults to 4 parallel uploads.

---

## 6. Recommended end-to-end flow (summary)

1. **Connect:** redirect to `/authorize` (confidential client, `scope=offline_access user:content:manage`, with `state`). On the callback, `POST /oauth/token` with `client_secret` and store the access and refresh tokens.
2. **Before each call:** if the token is within 30–60 s of `exp`, refresh it under a lock and persist the rotated refresh token.
3. **Per audio file:**
   1. Compute the SHA-256 (hex).
   2. `GET /media/transcode/audio/uploadUrl?sha256=..&filename=..`.
   3. If `uploadUrl` is not null, `PUT` the bytes to it.
   4. Poll `GET /media/upload/{uploadId}/transcoded?loudnorm=false` until `transcodedSha256` appears.
   5. Build the track: `trackUrl: "yoto:#"+transcodedSha256`, with `duration`, `fileSize`, `format` and `channels` copied from `transcodedInfo`.
4. **Optional:** upload a cover image (`imageL`) and icons (`yoto:#mediaId`).
5. **Save:** `POST /content` with `title`, `content.chapters` and `metadata.media` totals. Store the returned `card.cardId`, and send `cardId` on later saves to overwrite.
6. **Link:** the user links the playlist to a physical MYO card in the Yoto app.

---

## 7. Sources

- yoto.dev guides:
  - https://yoto.dev/get-started/start-here/
  - https://yoto.dev/get-started/glossary/
  - https://yoto.dev/get-started/verification-status/
  - https://yoto.dev/get-started/api-guidelines/
  - https://yoto.dev/authentication/auth/
  - https://yoto.dev/authentication/browser-auth/
  - https://yoto.dev/authentication/headless-cli-auth/
  - https://yoto.dev/authentication/device-code-migration/
  - https://yoto.dev/authentication/scopes/
  - https://yoto.dev/myo/how-playlists-work/
  - https://yoto.dev/myo/uploading-to-cards/
  - https://yoto.dev/myo/uploading-cover-images/
  - https://yoto.dev/myo/streaming-tracks/
  - https://yoto.dev/myo/how-shuffle-works/
  - https://yoto.dev/myo/labs-tts/
  - https://yoto.dev/icons/using-icons/
  - https://yoto.dev/icons/uploading-icons/
  - https://yoto.dev/icons/uploading-animated-gifs/
  - https://yoto.dev/icons/dynamic-icons/
  - https://yoto.dev/reference/card-content-schema/
  - https://yoto.dev/reference/terms-and-conditions/
- yoto.dev API reference:
  - https://yoto.dev/api/
  - `/api/authentication/get-authorize`, `post-oauth-token`, `post-oauth-device-code`
  - `/api/content/createOrUpdateContent`, `getContent`, `getUserSMyoContent`, `deleteContent`
  - `/api/media/getAnUploadUrl`, `uploadCoverImage`
  - `/api/icons/getPublicIcons`, `getUserIcons`, `uploadCustomIcon`
- First-party code:
  - https://github.com/yotoplay/examples (`next.js` confidential client, `vanilla-js-html/src/upload.js`)
  - https://github.com/yotoplay/yoto-sdk (`src/api/mediaApi.ts`, `contentApi.ts`, `iconsApi.ts`, `src/base/YotoBaseSdk.ts`)
  - https://github.com/yotoplay/twine-to-yoto (`lib/apis/api.yoto.ts`, `lib/types/transcode.ts`, `lib/uploading/yotoUploader.ts`)
- Yoto support:
  - https://support.yotoplay.com/en_gb/how-much-audio-fits-on-a-make-your-own-card-r1ssdFimfl
  - https://support.yotoplay.com/en_gb/how-to-add-your-own-mp3-files-to-a-yoto-card-rJl2utiQfe
- Community (gap-filling only):
  - https://github.com/xkjq/yoto-up (`src/yoto_up/yoto_api.py`, `models.py`)
  - https://github.com/mylacc/yoto-audiobookshelf-bridge (`yotobridge/yoto.py`)
  - https://github.com/cdnninja/yoto_api (still uses the device-code flow, and covers players only, not uploads)
