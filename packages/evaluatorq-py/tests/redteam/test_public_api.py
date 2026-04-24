# tests/redteam/test_public_api.py


def test_llm_config_importable():
    from evaluatorq.redteam import LLMConfig
    assert LLMConfig is not None


def test_openai_model_target_importable():
    from evaluatorq.redteam import OpenAIModelTarget
    assert OpenAIModelTarget is not None
