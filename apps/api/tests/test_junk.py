"""todo18: OS and VCS clutter never becomes a file (kernel side of the client's junk list)."""

import pytest

from studio_api.kernel.kinds import is_junk


@pytest.mark.parametrize("p", ["a/.git/HEAD", ".git/config", "x/Thumbs.db", "desktop.ini", "a/__MACOSX/b.png", "._x.png"])
def test_junk(p):
    assert is_junk(p)


@pytest.mark.parametrize("p", ["a/b.png", "git/notes.txt"])
def test_kept(p):
    assert not is_junk(p)
