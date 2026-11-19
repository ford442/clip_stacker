# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Andrew Kvochko

from typing import Protocol

from ltx_core.pipeline.conditioning.tools import LatentState, LatentTools


class ConditioningItem(Protocol):
    def apply_to(self, latent_state: LatentState, latent_tools: LatentTools) -> LatentState:
        """
        Apply the conditioning to the latent state.

        Args:
            latent_state: The latent state to apply the conditioning to. This is state always patchified.

        Returns:
            The latent state after the conditioning has been applied.

        IMPORTANT: If the conditioning needs to add extra tokens to the latent, it should add them to the end of the
        latent.
        """
        ...
