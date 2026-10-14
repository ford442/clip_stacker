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
# kiss_fft.c is C; link as C++ so libc++ is available (matches DEFAULT_TO_CXX).
set_source_files_properties(third_party/kissfft/kiss_fft.c PROPERTIES LANGUAGE C)
target_link_options(audio_analysis PRIVATE "SHELL:-s DEFAULT_TO_CXX=1")

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
