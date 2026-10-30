from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.artifact import Artifact
from ...models.problem import Problem
from ...types import File, FileTypes
from io import BytesIO
from typing import cast



def _get_kwargs(
    sha256: str,
    *,
    body: File,
    x_media_type: str,

) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    headers["X-Media-Type"] = x_media_type



    

    

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/internal/v1/artifacts/{sha256}".format(sha256=sha256,),
    }

    _kwargs["content"] = body.payload

    headers["Content-Type"] = "application/octet-stream"

    _kwargs["headers"] = headers
    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Artifact | Problem:
    if response.status_code == 200:
        response_200 = Artifact.from_dict(response.json())



        return response_200

    if response.status_code == 201:
        response_201 = Artifact.from_dict(response.json())



        return response_201

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
    body: File,
    x_media_type: str,

) -> Response[Artifact | Problem]:
    """  Streams raw bytes to staging. Hash and length are verified before the object becomes visible.

    Args:
        sha256 (str):
        x_media_type (str):
        body (File):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Artifact | Problem]
     """


    kwargs = _get_kwargs(
        sha256=sha256,
body=body,
x_media_type=x_media_type,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    sha256: str,
    *,
    client: AuthenticatedClient | Client,
    body: File,
    x_media_type: str,

) -> Artifact | Problem | None:
    """  Streams raw bytes to staging. Hash and length are verified before the object becomes visible.

    Args:
        sha256 (str):
        x_media_type (str):
        body (File):

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
x_media_type=x_media_type,

    ).parsed

async def asyncio_detailed(
    sha256: str,
    *,
    client: AuthenticatedClient | Client,
    body: File,
    x_media_type: str,

) -> Response[Artifact | Problem]:
    """  Streams raw bytes to staging. Hash and length are verified before the object becomes visible.

    Args:
        sha256 (str):
        x_media_type (str):
        body (File):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Artifact | Problem]
     """


    kwargs = _get_kwargs(
        sha256=sha256,
body=body,
x_media_type=x_media_type,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    sha256: str,
    *,
    client: AuthenticatedClient | Client,
    body: File,
    x_media_type: str,

) -> Artifact | Problem | None:
    """  Streams raw bytes to staging. Hash and length are verified before the object becomes visible.

    Args:
        sha256 (str):
        x_media_type (str):
        body (File):

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
x_media_type=x_media_type,

    )).parsed
