from datetime import date


class KeepSignedIn:
    """Push a signed-in session's expiry forward, at most once a day.

    Sessions last ``SESSION_COOKIE_AGE`` from the last renewal, so anyone who opens the app now and then stays signed
    in until they sign out. Renewing on every request would also work, but the player and job list poll every few
    seconds, and each renewal is a database write.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.user.is_authenticated:
            today = date.today().isoformat()
            if request.session.get("renewed_on") != today:
                request.session["renewed_on"] = today  # marks the session modified, so the cookie is sent again
        return self.get_response(request)
