# Copyright (c) 2025 Lightricks. All rights reserved.

from ltx_core.loader.sd_ops import (
    ContentMatching,
    ContentReplacement,
    SDOps,
)


class TestSDOps:
    def test_creation_minimal(self) -> None:
        ops = SDOps("test_ops")
        assert ops.name == "test_ops"
        assert ops.mapping == ()

    def test_with_replacement_creates_new_instance(self) -> None:
        ops = SDOps("test")
        new_ops = ops.with_replacement("old", "new")
        assert ops.mapping == ()
        assert len(new_ops.mapping) == 1
        assert isinstance(new_ops.mapping[0], ContentReplacement)
        assert new_ops.mapping[0].content == "old"
        assert new_ops.mapping[0].replacement == "new"

    def test_with_replacement_chaining(self) -> None:
        ops = SDOps("test").with_replacement("a", "b").with_replacement("c", "d")
        assert len(ops.mapping) == 2
        assert ops.mapping[0] == ContentReplacement("a", "b")
        assert ops.mapping[1] == ContentReplacement("c", "d")

    def test_with_matching_creates_new_instance(self) -> None:
        ops = SDOps("test")
        new_ops = ops.with_matching(prefix="model.", suffix=".weight")
        assert ops.mapping == ()
        assert len(new_ops.mapping) == 1
        assert isinstance(new_ops.mapping[0], ContentMatching)
        assert new_ops.mapping[0].prefix == "model."
        assert new_ops.mapping[0].suffix == ".weight"

    def test_with_matching_chaining(self) -> None:
        ops = SDOps("test").with_matching(prefix="a.", suffix="b.").with_matching(prefix="c.", suffix="d.")
        assert len(ops.mapping) == 2
        assert ops.mapping[0] == ContentMatching(prefix="a.", suffix="b.")
        assert ops.mapping[1] == ContentMatching(prefix="c.", suffix="d.")

    def test_mixed_chaining(self) -> None:
        ops = SDOps("test").with_matching(prefix="model.").with_replacement("old", "new")
        assert len(ops.mapping) == 2
        assert isinstance(ops.mapping[0], ContentMatching)
        assert isinstance(ops.mapping[1], ContentReplacement)


class TestSDOpsApply:
    def test_apply_without_matching_returns_none(self) -> None:
        ops = SDOps("test")
        result = ops.apply_to_key("any.key.name")
        assert result is None

    def test_apply_with_passthrough_matcher(self) -> None:
        ops = SDOps("test").with_matching()
        result = ops.apply_to_key("any.key.name")
        assert result == "any.key.name"

    def test_apply_single_replacement(self) -> None:
        ops = SDOps("test").with_matching().with_replacement("old", "new")
        assert ops.apply_to_key("old.key") == "new.key"
        assert ops.apply_to_key("my.old.key") == "my.new.key"
        assert ops.apply_to_key("no_match") == "no_match"

    def test_apply_multiple_replacements(self) -> None:
        ops = SDOps("test").with_matching().with_replacement("model.", "").with_replacement(".weight", ".bias")
        result = ops.apply_to_key("model.layer.weight")
        assert result == "layer.bias"

    def test_apply_with_matching_prefix_passes(self) -> None:
        ops = SDOps("test").with_matching(prefix="model.").with_replacement("model.", "")
        result = ops.apply_to_key("model.layer.weight")
        assert result == "layer.weight"

    def test_apply_with_matching_prefix_fails(self) -> None:
        ops = SDOps("test").with_matching(prefix="model.").with_replacement("layer", "block")
        result = ops.apply_to_key("other.layer.weight")
        assert result is None

    def test_apply_with_matching_suffix_passes(self) -> None:
        ops = SDOps("test").with_matching(suffix=".weight")
        result = ops.apply_to_key("model.layer.weight")
        assert result == "model.layer.weight"

    def test_apply_with_matching_suffix_fails(self) -> None:
        ops = SDOps("test").with_matching(suffix=".weight")
        result = ops.apply_to_key("model.layer.bias")
        assert result is None

    def test_apply_with_matching_prefix_and_suffix_passes(self) -> None:
        ops = SDOps("test").with_matching(prefix="model.", suffix=".weight")
        result = ops.apply_to_key("model.layer.weight")
        assert result == "model.layer.weight"

    def test_apply_with_matching_prefix_and_suffix_fails_prefix(self) -> None:
        ops = SDOps("test").with_matching(prefix="model.", suffix=".weight")
        result = ops.apply_to_key("other.layer.weight")
        assert result is None

    def test_apply_with_matching_prefix_and_suffix_fails_suffix(self) -> None:
        ops = SDOps("test").with_matching(prefix="model.", suffix=".weight")
        result = ops.apply_to_key("model.layer.bias")
        assert result is None

    def test_apply_with_multiple_matchers_any_match_passes(self) -> None:
        ops = SDOps("test").with_matching(prefix="model.").with_matching(prefix="other.")
        assert ops.apply_to_key("model.layer") == "model.layer"
        assert ops.apply_to_key("other.layer") == "other.layer"
        assert ops.apply_to_key("unknown.layer") is None

    def test_apply_replacement_all_occurrences(self) -> None:
        ops = SDOps("test").with_matching().with_replacement("block", "layer")
        result = ops.apply_to_key("block.sub_block.block")
        assert result == "layer.sub_layer.layer"


class TestSDOpsImmutability:
    def test_original_unchanged_after_with_replacement(self) -> None:
        original = SDOps("test")
        _ = original.with_replacement("a", "b")
        assert original.mapping == ()

    def test_original_unchanged_after_with_matching(self) -> None:
        original = SDOps("test")
        _ = original.with_matching(prefix="model.")
        assert original.mapping == ()

    def test_chained_ops_are_independent(self) -> None:
        base = SDOps("test")
        ops1 = base.with_replacement("a", "b")
        ops2 = base.with_replacement("c", "d")
        assert ops1.mapping != ops2.mapping
        assert len(ops1.mapping) == 1
        assert len(ops2.mapping) == 1
        assert ops1.mapping[0].content == "a"
        assert ops2.mapping[0].content == "c"
