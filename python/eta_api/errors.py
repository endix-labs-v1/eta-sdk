"""The one error the SDK raises."""
from __future__ import annotations

from typing import Any, Dict, Mapping, Optional


class EtaError(Exception):
    """A call eta refused, a call that got no answer, or a stream that stopped for good.

    Attributes:
        status: The HTTP status, such as 400 or 429. 0 when no answer came
            (a network error or a timeout), and for a stream that stopped.
        err: The API's own words, such as ``"price moved"`` or ``"scope"``.
            ``"network"`` when no answer came.
        fields: The answer's other fields, such as ``{"need": "trade"}`` or
            ``{"price": 40.61, "quoted": 40.346224}``.
        request_id: The answer's ``X-Request-Id``. Quote it when you ask eta
            about a call. ``None`` when no answer came.
        client_id: The ``clientId`` an order or close was sent with. Send the
            same order again with it, or look for it in ``me()``.
        code: A stream's close code, such as 4001. ``None`` for HTTP calls.
        body: The whole answer: a dict, or the text when it was not JSON.
    """

    def __init__(
        self,
        status: int,
        err: str,
        *,
        fields: Optional[Mapping[str, Any]] = None,
        request_id: Optional[str] = None,
        client_id: Optional[str] = None,
        code: Optional[int] = None,
        body: Any = None,
    ) -> None:
        self.status = status
        self.err = err
        self.fields: Dict[str, Any] = dict(fields or {})
        self.request_id = request_id
        self.client_id = client_id
        self.code = code
        self.body = body
        super().__init__(self._message())

    @property
    def retry_after(self) -> Optional[float]:
        """With ``too fast``: the seconds eta asked you to wait."""
        value = self.fields.get("retryAfter")
        return float(value) if isinstance(value, (int, float)) else None

    def _message(self) -> str:
        head = f"{self.status} {self.err}" if self.status else self.err
        if self.code is not None:
            head = f"stream closed {self.code}: {self.err}"
        parts = [head]
        if self.fields:
            parts.append("(" + ", ".join(f"{k}: {v}" for k, v in self.fields.items()) + ")")
        if self.client_id:
            parts.append(f"[clientId {self.client_id}]")
        if self.request_id:
            parts.append(f"[X-Request-Id {self.request_id}]")
        return " ".join(parts)
