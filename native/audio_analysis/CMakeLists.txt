if(CLIP_STACKER_HOST_TESTS)
  # Same sources as the WASM module; the C API has no Embind, so the "bindings"
  # are just the EXPORTED_FUNCTIONS list below.
  add_library(audio_analysis_dsp STATIC
    audio_analysis.cpp
    third_party/kissfft/kiss_fft.c
  )
  target_include_directories(audio_analysis_dsp PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/kissfft"
  )
  clip_stacker_host_target(audio_analysis_dsp)
  # Vendored code stays untouched; silence its one -Wextra nit.
  set_source_files_properties(third_party/kissfft/kiss_fft.c PROPERTIES COMPILE_OPTIONS -Wno-sign-compare)
  # kissfft is C; cxx_std_17 is harmless on it, and it gets the same
  # -ffp-contract=off as the C++ so host FFT numbers match WASM.
  clip_stacker_host_test(audio_analysis_tests tests/audio_analysis_tests.cpp audio_analysis_dsp)
  return()
endif()

add_executable(audio_analysis
  audio_analysis.cpp
  third_party/kissfft/kiss_fft.c
)
target_include_directories(audio_analysis PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/third_party/kissfft"
)
# kiss_fft.c compiles as C; the target links with em++ (CMake's linker
# language is CXX because audio_analysis.cpp is C++), so libc++ is available.
# Vendored code stays untouched: silence its -Wextra nit, and its own DEBUG
# macro colliding with the toolchain's debug-build define.
set_source_files_properties(third_party/kissfft/kiss_fft.c PROPERTIES COMPILE_OPTIONS "-Wno-sign-compare;-Wno-macro-redefined")

clip_stacker_wasm_module(audio_analysis
  EXPORT_NAME createAudioAnalysisModule
  INITIAL_MEMORY 4194304
  MAXIMUM_MEMORY 67108864
  EXPORTED_FUNCTIONS
    _createAnalyzer
    _analyzeFrame
    _resetAnalyzer
    _destroyAnalyzer
    _getHopSize
)
