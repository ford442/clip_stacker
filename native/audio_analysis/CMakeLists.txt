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
