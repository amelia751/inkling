from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.annotation_revision import AnnotationRevision
from ...models.content_ref import ContentRef
from ...models.problem import Problem
from typing import cast



def _get_kwargs(
    *,
    body: AnnotationRevision,

) -> dict[str, Any]:
    headers: dict[str, Any] = {}


    

    

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/internal/v1/annotation-revisions",
    }

    _kwargs["json"] = body.to_dict()


    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> ContentRef | Problem:
    if response.status_code == 201:
        response_201 = ContentRef.from_dict(response.json())



        return response_201

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[ContentRef | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: AnnotationRevision,

) -> Response[ContentRef | Problem]:
    """  Canonicalises, validates and stores an immutable annotation-revision document as an artifact.

    Args:
        body (AnnotationRevision): Mirrors schemas/versioning/annotation-revision.schema.json.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ContentRef | Problem]
     """


    kwargs = _get_kwargs(
        body=body,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    *,
    client: AuthenticatedClient | Client,
    body: AnnotationRevision,

) -> ContentRef | Problem | None:
    """  Canonicalises, validates and stores an immutable annotation-revision document as an artifact.

    Args:
        body (AnnotationRevision): Mirrors schemas/versioning/annotation-revision.schema.json.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ContentRef | Problem
     """


    return sync_detailed(
        client=client,
body=body,

    ).parsed

async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: AnnotationRevision,

) -> Response[ContentRef | Problem]:
    """  Canonicalises, validates and stores an immutable annotation-revision document as an artifact.

    Args:
        body (AnnotationRevision): Mirrors schemas/versioning/annotation-revision.schema.json.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ContentRef | Problem]
     """


    kwargs = _get_kwargs(
        body=body,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: AnnotationRevision,

) -> ContentRef | Problem | None:
    """  Canonicalises, validates and stores an immutable annotation-revision document as an artifact.

    Args:
        body (AnnotationRevision): Mirrors schemas/versioning/annotation-revision.schema.json.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ContentRef | Problem
     """


    return (await asyncio_detailed(
        client=client,
body=body,

    )).parsed
