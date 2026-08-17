"""Static checks that the Gradio UI and the generate handler agree.

app.py downloads checkpoints at import time, so these parse it instead. The bug
class being guarded against is a control that is rendered, passed into
`gr.on(inputs=[...])`, and then never read by the handler — the user moves a
slider and nothing happens.
"""

import ast
import os

import pytest

APP_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.py")

# Gradio passes inputs positionally, so the Nth component in every `inputs=[...]`
# list lands on the Nth parameter of the handler. The names differ, hence this
# map; keeping it explicit is what makes an ordering slip a test failure.
COMPONENT_TO_PARAM = {
    "prompt": "prompt",
    "negative_prompt": "negative_prompt",
    "use_negative_prompt": "use_negative_prompt",
    "style_selection": "style_selection",
    "width": "width",
    "height": "height",
    "guidance_scale": "guidance_scale",
    "num_inference_steps": "num_inference_steps",
    "latent_file": "latent_file",
    "latent_file_2": "latent_file_2",
    "latent_file_3": "latent_file_3",
    "latent_file_4": "latent_file_4",
    "latent_file_5": "latent_file_5",
    "text_strength": "text_scale",
    "ip_strength": "ip_scale",
    "file_1_strength": "latent_file_1_scale",
    "file_2_strength": "latent_file_2_scale",
    "file_3_strength": "latent_file_3_scale",
    "file_4_strength": "latent_file_4_scale",
    "file_5_strength": "latent_file_5_scale",
    "combine_mode": "combine_mode",
    "samples": "samples",
}


@pytest.fixture(scope="module")
def tree():
    with open(APP_PATH) as handle:
        return ast.parse(handle.read())


@pytest.fixture(scope="module")
def handler(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "run_generation":
            return node
    pytest.fail("run_generation not found in app.py")


@pytest.fixture(scope="module")
def input_lists(tree):
    """Every `inputs=[...]` passed to a gr.on(...) call, as name lists."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "on"):
            continue
        for keyword in node.keywords:
            if keyword.arg == "inputs" and isinstance(keyword.value, ast.List):
                found.append([element.id for element in keyword.value.elts
                              if isinstance(element, ast.Name)])
    return found


def param_names(func_node):
    return [arg.arg for arg in func_node.args.args]


def test_there_are_three_generate_triggers(input_lists):
    assert len(input_lists) == 3


def test_all_triggers_share_one_input_list(input_lists):
    """The three duration variants must not drift apart again."""
    assert input_lists[0] == input_lists[1] == input_lists[2]


def test_inputs_line_up_with_handler_parameters(input_lists, handler):
    params = param_names(handler)
    assert params[-1] == "progress", "progress must stay last, Gradio fills it in"
    expected = [COMPONENT_TO_PARAM[name] for name in input_lists[0]]
    assert expected == params[:-1]


def test_every_handler_parameter_is_used(handler):
    """A parameter the body never reads is a dead control by definition."""
    declared = set(param_names(handler)) - {"progress"}
    body = ast.Module(body=handler.body, type_ignores=[])
    used = {node.id for node in ast.walk(body) if isinstance(node, ast.Name)}
    unused = sorted(declared - used)
    assert not unused, f"declared but never read: {unused}"


def test_duration_wrappers_delegate_to_the_shared_handler(tree):
    wrappers = {"generate_30", "generate_60", "generate_90"}
    seen = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in wrappers:
            calls = {child.func.id for child in ast.walk(node)
                     if isinstance(child, ast.Call) and isinstance(child.func, ast.Name)}
            seen[node.name] = calls
    assert set(seen) == wrappers
    for name, calls in seen.items():
        assert "run_generation" in calls, f"{name} does not delegate"


def test_no_blocking_upload_inside_the_gpu_handler(handler):
    """FTP I/O belongs on a background thread, not inside @spaces.GPU."""
    direct_calls = {node.func.id for node in ast.walk(handler)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
    assert "upload_to_ftp" not in direct_calls
    assert "upload_in_background" in direct_calls


def test_handler_does_not_leak_matmul_precision(handler):
    """Set it inside a scope that restores it, never bare."""
    for node in ast.walk(handler):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "set_float32_matmul_precision"):
            pytest.fail("set_float32_matmul_precision called directly in the handler; "
                        "use the matmul_precision() context manager")


def test_width_and_height_reach_the_model(handler):
    for node in ast.walk(handler):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "generate"):
            passed = {keyword.arg for keyword in node.keywords}
            assert {"width", "height", "combine_mode"} <= passed
            return
    pytest.fail("no ip_model.generate(...) call found")


def test_apply_style_is_called(handler):
    for node in ast.walk(handler):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id == "apply_style":
                return
    pytest.fail("apply_style must be called in run_generation")


def test_use_negative_prompt_gates_user_negative(handler):
    """The checkbox must suppress the user's negative box, not the style preset."""
    for node in ast.walk(handler):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        if node.func.id != "apply_style":
            continue
        if len(node.args) < 3:
            continue
        third = node.args[2]
        if isinstance(third, ast.IfExp) and isinstance(third.test, ast.Name):
            if third.test.id == "use_negative_prompt":
                return
    pytest.fail("apply_style third arg must be negative_prompt if use_negative_prompt else ''")


def test_upscaler_receives_first_image_not_full_batch(handler):
    for node in ast.walk(handler):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "upscaler":
            if node.args and isinstance(node.args[0], ast.Subscript):
                return
    pytest.fail("upscaler must be called with sd_image[0], not the full sample list")
