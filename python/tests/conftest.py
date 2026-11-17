"""Test setup: a net guard, and the mock API.

No test reaches a real network unless ETA_API and ETA_KEY are both set (the
integration tests). The guard refuses every connection and name lookup that is
not this machine, and says so.
"""
from __future__ import annotations

import os
import socket
import sys
from typing import Any, Iterator

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from mock_server import KEY, Log, MockHttp  # noqa: E402

from eta_api import EtaClient  # noqa: E402

LOCAL = {"127.0.0.1", "::1", "localhost"}
INTEGRATION = bool(os.environ.get("ETA_API") and os.environ.get("ETA_KEY"))


def _install_net_guard() -> None:
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo

    def _check(sock: socket.socket, address: Any) -> None:
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            host = address[0] if isinstance(address, tuple) else address
            if host not in LOCAL:
                raise ConnectionRefusedError(f"test: real network refused {host}")

    def connect(self: socket.socket, address: Any) -> None:
        _check(self, address)
        return real_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> int:
        _check(self, address)
        return real_connect_ex(self, address)

    def getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        name = host.decode() if isinstance(host, bytes) else host
        if name is not None and name not in LOCAL:
            raise socket.gaierror(f"test: real network refused {name}")
        return real_getaddrinfo(host, *args, **kwargs)

    socket.socket.connect = connect  # type: ignore[method-assign]
    socket.socket.connect_ex = connect_ex  # type: ignore[method-assign]
    socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]


if not INTEGRATION:
    _install_net_guard()


class Sleeps:
    """Stands in for time.sleep: notes each wait and returns at once."""

    def __init__(self) -> None:
        self.waits: list = []

    def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


@pytest.fixture
def log() -> Log:
    return Log()


@pytest.fixture
def api(log: Log) -> Iterator[MockHttp]:
    server = MockHttp(log)
    yield server
    server.close()


@pytest.fixture
def sleeps() -> Sleeps:
    return Sleeps()


@pytest.fixture
def client(api: MockHttp, sleeps: Sleeps) -> EtaClient:
    return EtaClient(KEY, api.url, sleep=sleeps)
