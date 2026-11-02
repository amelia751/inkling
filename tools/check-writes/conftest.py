def pytest_addoption(parser):
    parser.addoption("--update-writes", action="store_true", help="regenerate tools/check-writes/allowlist.txt")
