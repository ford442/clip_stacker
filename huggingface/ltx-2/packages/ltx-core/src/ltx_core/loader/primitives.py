# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Alexey Kravtsov
from dataclasses import dataclass
from typing import NamedTuple, Protocol

import torch

from ltx_core.loader.module_ops import ModuleOps
from ltx_core.loader.sd_ops import SDOps
from ltx_core.model.model_protocol import ModelType


@dataclass(frozen=True)
class StateDict:
    sd: dict
    device: torch.device
    size: int
    dtype: set[torch.dtype]

    def footprint(self) -> tuple[int, torch.device]:
        return self.size, self.device


class StateDictLoader(Protocol):
    def metadata(self, path: str) -> dict:
        """
        Load metadata from path
        """

    def load(self, path: str | list[str], sd_ops: SDOps | None = None, device: torch.device | None = None) -> StateDict:
        """
        Load state dict from path or paths (for sharded model storage) and apply sd_ops
        """


class ModelBuilderProtocol(Protocol[ModelType]):
    def meta_model(self, config: dict, module_ops: list[ModuleOps] | None = None) -> ModelType: ...

    def build(self, dtype: torch.dtype | None = None) -> ModelType:
        """
        Build the model
        Args:
            dtype: Target dtype for the model, if None, uses the dtype of the model_path model
        Returns:
            Model instance
        """
        ...


class LoRAAdaptableProtocol(Protocol):
    def lora(self, lora_path: str, strength: float) -> "LoRAAdaptableProtocol":
        pass


class LoraPathStrengthAndSDOps(NamedTuple):
    path: str
    strength: float
    sd_ops: SDOps


class LoraStateDictWithStrength(NamedTuple):
    state_dict: StateDict
    strength: float
