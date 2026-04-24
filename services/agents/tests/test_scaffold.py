from brain_agents import SERVICE_NAME, __version__


def test_service_name() -> None:
    assert SERVICE_NAME == "brain-agents"


def test_version() -> None:
    assert __version__ == "0.1.0"
