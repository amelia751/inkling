from http import HTTPStatus
from typing import Any, cast

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.check_report import CheckReport
from ...models.problem import Problem
from ...models.review import Review
from typing import cast
from uuid import UUID



def _get_kwargs(
    repo_id: UUID,
    review_id: UUID,
    check_name: str,
    *,
    body: CheckReport,

) -> dict[str, Any]:
    headers: dict[str, Any] = {}


    

    

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/internal/v1/repos/{repo_id}/reviews/{review_id}/checks/{check_name}".format(repo_id=repo_id,review_id=review_id,check_name=check_name,),
    }

    _kwargs["json"] = body.to_dict()


    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs



def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Problem | Review:
    if response.status_code == 200:
        response_200 = Review.from_dict(response.json())



        return response_200

    response_default = Problem.from_dict(response.json())



    return response_default



def _build_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Response[Problem | Review]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    repo_id: UUID,
    review_id: UUID,
    check_name: str,
    *,
    client: AuthenticatedClient | Client,
    body: CheckReport,

) -> Response[Problem | Review]:
    """  A worker reports an externally computed check (e.g. de-identification) for immutable OIDs.

    Args:
        repo_id (UUID):
        review_id (UUID):
        check_name (str):
        body (CheckReport):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Review]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
review_id=review_id,
check_name=check_name,
body=body,

    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)

def sync(
    repo_id: UUID,
    review_id: UUID,
    check_name: str,
    *,
    client: AuthenticatedClient | Client,
    body: CheckReport,

) -> Problem | Review | None:
    """  A worker reports an externally computed check (e.g. de-identification) for immutable OIDs.

    Args:
        repo_id (UUID):
        review_id (UUID):
        check_name (str):
        body (CheckReport):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Review
     """


    return sync_detailed(
        repo_id=repo_id,
review_id=review_id,
check_name=check_name,
client=client,
body=body,

    ).parsed

async def asyncio_detailed(
    repo_id: UUID,
    review_id: UUID,
    check_name: str,
    *,
    client: AuthenticatedClient | Client,
    body: CheckReport,

) -> Response[Problem | Review]:
    """  A worker reports an externally computed check (e.g. de-identification) for immutable OIDs.

    Args:
        repo_id (UUID):
        review_id (UUID):
        check_name (str):
        body (CheckReport):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Review]
     """


    kwargs = _get_kwargs(
        repo_id=repo_id,
review_id=review_id,
check_name=check_name,
body=body,

    )

    response = await client.get_async_httpx_client().request(
        **kwargs
    )

    return _build_response(client=client, response=response)

async def asyncio(
    repo_id: UUID,
    review_id: UUID,
    check_name: str,
    *,
    client: AuthenticatedClient | Client,
    body: CheckReport,

) -> Problem | Review | None:
    """  A worker reports an externally computed check (e.g. de-identification) for immutable OIDs.

    Args:
        repo_id (UUID):
        review_id (UUID):
        check_name (str):
        body (CheckReport):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Review
     """


    return (await asyncio_detailed(
        repo_id=repo_id,
review_id=review_id,
check_name=check_name,
client=client,
body=body,

    )).parsed
