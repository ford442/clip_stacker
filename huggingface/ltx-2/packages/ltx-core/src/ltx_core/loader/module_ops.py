# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Alexey Kravtsov
from typing import Callable, NamedTuple

import torch


class ModuleOps(NamedTuple):
    name: str
    matcher: Callable[[torch.nn.Module], bool]
    mutator: Callable[[torch.nn.Module], torch.nn.Module]
