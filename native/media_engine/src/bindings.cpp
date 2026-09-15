#include "audio_mix.h"

// EXPORTED_FUNCTIONS entry points live in audio_mix.cpp (extern "C").
// This TU exists so the CMake target matches the proposed layout and can grow
// Embind / logger surface without touching the mix inner loop.
