from ninja import NinjaAPI
from ninja.security import django_auth

from audible_books.api import router as audible_router
from core.api import router as core_router
from core.auth import router as auth_router
from core.users import router as users_router
from local_audio.api import router as local_router
from podcasts.api import router as podcasts_router
from transcripts.api import router as transcripts_router
from yoto.api import router as yoto_router

api = NinjaAPI(title="Audio", version="1.0", auth=django_auth, docs_url="/docs")

api.add_router("/auth", auth_router)
api.add_router("/users", users_router)
api.add_router("/", core_router)
api.add_router("/audible", audible_router)
api.add_router("/podcasts", podcasts_router)
api.add_router("/local", local_router)
api.add_router("/transcripts", transcripts_router)
api.add_router("/yoto", yoto_router)
