from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.artifact import Artifact
from ...models.problem import Problem
from ...models.purge_request import PurgeRequest
from typing import cast



def _get_kwargs(
    sha256: str,
    *,
    body: PurgeRequest,
    idempotency_key: str,

) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["Idempotency-Key"] = idempotency_key



    

    

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/internal/v1/artifacts/{sha256}/purge".format(sha256=sha256,),
    }

    _kwargs["json"] = body.to_dict()


    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Artifact | Problem:
    if response.status_code == 200:
        response_200 = Artifact.from_dict(response.json())



        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Artifact | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sha256: str,
    *,
    client: AuthenticatedClient | Client,
    body: PurgeRequest,
    idempotency_key: str,

) -> Response[Artifact | Problem]:
    """  Deletes the bytes of a withdrawn artifact (todo4 V9). Disabled unless PURGE_ENABLED; blocked by
    legal holds and by any live branch head or release still referencing it.

    Args:
        sha256 (str):
        idempotency_key (str):
        body (PurgeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Artifact | Problem]
     """


    kwargs = _get_kwargs(
        sha256=sha256,
body=body,
idempotency_key=idempotency_key,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    sha256: str,
    *,
    client: AuthenticatedClient | Client,
    body: PurgeRequest,
    idempotency_key: str,

) -> Artifact | Problem | None:
    """  Deletes the bytes of a withdrawn artifact (todo4 V9). Disabled unless PURGE_ENABLED; blocked by
    legal holds and by any live branch head or release still referencing it.

    Args:
        sha256 (str):
        idempotency_key (str):
        body (PurgeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Artifact | Problem
     """


    return sync_detailed(
        sha256=sha256,
client=client,
body=body,
idempotency_key=idempotency_key,

    ).parsed

async def asyncio_detailed(
    sha256: str,
    *,
    client: AuthenticatedClient | Client,
    body: PurgeRequest,
    idempotency_key: str,

) -> Response[Artifact | Problem]:
    """  Deletes the bytes of a withdrawn artifact (todo4 V9). Disabled unless PURGE_ENABLED; blocked by
    legal holds and by any live branch head or release still referencing it.

    Args:
        sha256 (str):
        idempotency_key (str):
        body (PurgeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Artifact | Problem]
     """


    kwargs = _get_kwargs(
        sha256=sha256,
body=body,
idempotency_key=idempotency_key,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    sha256: str,
    *,
    client: AuthenticatedClient | Client,
    body: PurgeRequest,
    idempotency_key: str,

) -> Artifact | Problem | None:
    """  Deletes the bytes of a withdrawn artifact (todo4 V9). Disabled unless PURGE_ENABLED; blocked by
    legal holds and by any live branch head or release still referencing it.

    Args:
        sha256 (str):
        idempotency_key (str):
        body (PurgeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Artifact | Problem
     """


    return (await asyncio_detailed(
        sha256=sha256,
client=client,
body=body,
idempotency_key=idempotency_key,

    )).parsed
