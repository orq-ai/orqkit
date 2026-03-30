"""Tests for extract_json utility."""

from evaluatorq.simulation.utils.extract_json import extract_json_from_response


def test_extract_from_code_block():
    content = '```json\n[{"name": "test"}]\n```'
    result = extract_json_from_response(content)
    assert result == '[{"name": "test"}]'


def test_extract_from_code_block_no_lang():
    content = '```\n[{"name": "test"}]\n```'
    result = extract_json_from_response(content)
    assert result == '[{"name": "test"}]'


def test_extract_plain_array():
    content = 'Here is the result: [{"name": "test"}]'
    result = extract_json_from_response(content)
    assert result == '[{"name": "test"}]'


def test_extract_plain_object():
    content = 'The result: {"name": "test"}'
    result = extract_json_from_response(content)
    assert result == '{"name": "test"}'


def test_extract_empty_string():
    assert extract_json_from_response("") == ""


def test_extract_no_json():
    result = extract_json_from_response("just some text")
    assert result == "just some text"


def test_extract_nested_brackets():
    content = '[{"criteria": [{"type": "must_happen"}]}]'
    result = extract_json_from_response(content)
    assert '"must_happen"' in result


def test_extract_with_surrounding_text():
    content = (
        'Here are the personas:\n```json\n[{"name": "Alice"}]\n```\nHope that helps!'
    )
    result = extract_json_from_response(content)
    assert result == '[{"name": "Alice"}]'
