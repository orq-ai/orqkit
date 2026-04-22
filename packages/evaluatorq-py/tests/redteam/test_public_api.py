# tests/redteam/test_public_api.py
import warnings
import pytest


def test_llm_config_importable():
    from evaluatorq.redteam import LLMConfig
    assert LLMConfig is not None


def test_openai_model_target_importable():
    from evaluatorq.redteam import OpenAIModelTarget
    assert OpenAIModelTarget is not None


@pytest.fixture(autouse=True)
def reset_deprecated_warned():
    """Clear the deprecation-warned set so warnings fire afresh each test."""
    import evaluatorq.redteam as rt
    rt._deprecated_warned.clear()
    yield
    rt._deprecated_warned.clear()


def test_red_team_config_alias_warns():
    import evaluatorq.redteam as rt
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        _ = rt.RedTeamConfig  # triggers __getattr__
    dep = [x for x in w if issubclass(x.category, DeprecationWarning)]
    assert dep, "Expected DeprecationWarning, got none"
    assert any('LLMConfig' in str(x.message) for x in dep)


def test_pipeline_llm_config_alias_warns():
    import evaluatorq.redteam as rt
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        _ = rt.PipelineLLMConfig
    dep = [x for x in w if issubclass(x.category, DeprecationWarning)]
    assert dep, "Expected DeprecationWarning, got none"
    assert any('LLMConfig' in str(x.message) for x in dep)


def test_red_team_config_still_returns_llm_config_class():
    import evaluatorq.redteam as rt
    from evaluatorq.redteam.contracts import LLMConfig
    with warnings.catch_warnings(record=True):
        warnings.simplefilter('always')
        assert rt.RedTeamConfig is LLMConfig
