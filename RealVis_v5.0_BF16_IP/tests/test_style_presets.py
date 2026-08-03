"""Unit tests for Quality Style presets and negative-prompt gating semantics."""

import pytest

from style_presets import apply_style, DEFAULT_STYLE_NAME, STYLE_NAMES


def test_style_names_include_style_zero():
    assert DEFAULT_STYLE_NAME in STYLE_NAMES


def test_style_zero_is_prompt_pass_through():
    positive, negative = apply_style("Style Zero", "a cat on a roof", "user neg")
    assert positive == "a cat on a roof"
    assert negative == "user neg"


def test_hd_plus_wraps_prompt_and_adds_preset_negative():
    positive, negative = apply_style("HD+", "a cat", "extra")
    assert positive.startswith("hyper-realistic 2K image of a cat")
    assert "cartoonish" in negative
    assert negative.endswith("extra")


def test_unknown_style_falls_back_to_style_zero():
    positive, negative = apply_style("not a real preset", "hello", "nope")
    assert positive == "hello"
    assert negative == "nope"


def test_preset_negative_without_user_negative():
    positive, negative = apply_style("3840 x 2160", "scene", "")
    assert "8K" in positive
    assert "cartoonish" in negative
    assert not negative.endswith(" ")


def test_user_negative_disabled_semantics():
    """run_generation passes '' when use_negative_prompt is false; preset negative stays."""
    _, with_user = apply_style("HD+", "x", "user block")
    _, without_user = apply_style("HD+", "x", "")
    assert "cartoonish" in with_user and "user block" in with_user
    assert "cartoonish" in without_user
    assert "user block" not in without_user
