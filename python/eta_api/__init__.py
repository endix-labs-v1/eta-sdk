"""The eta API for Python: read, post, run your narratives and trade by code.

    from eta_api import EtaClient

    eta = EtaClient("eta_...")
    print(eta.me()["user"]["cash"])

Docs: https://eta-cash.gitbook.io/api/
"""
from ._version import __version__
from .client import DEFAULT_BASE_URL, UNSET, EtaClient, RateLimit, new_client_id
from .errors import EtaError
from .stream import EtaStream

__all__ = [
    "DEFAULT_BASE_URL",
    "UNSET",
    "EtaClient",
    "EtaError",
    "EtaStream",
    "RateLimit",
    "new_client_id",
    "__version__",
]
