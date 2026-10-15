if(CLIP_STACKER_HOST_TESTS)
  # stab_math.h (matrix / smoothing helpers) is header-only, so the tests can
  # include it directly as well as the C API.
  add_library(video_stabilize_dsp STATIC video_stabilize.cpp)
  target_include_directories(video_stabilize_dsp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
  clip_stacker_host_target(video_stabilize_dsp)
  clip_stacker_host_test(video_stabilize_tests tests/video_stabilize_tests.cpp video_stabilize_dsp)
  # stab_math.h is an anonymous-namespace header; tests use only part of it.
  target_compile_options(video_stabilize_tests PRIVATE -Wno-unused-function)
  return()
endif()

add_executable(video_stabilize video_stabilize.cpp)
target_include_directories(video_stabilize PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

clip_stacker_wasm_module(video_stabilize
  EXPORT_NAME createVideoStabilizeModule
  INITIAL_MEMORY 4194304
  MAXIMUM_MEMORY 134217728
  EXPORTED_FUNCTIONS
    _stab_create
    _stab_push_frame
    _stab_frame_count
    _stab_finalize
    _stab_get_matrix
    _stab_get_zoom
    _stab_get_max_correction
    _stab_apply_warp
    _stab_destroy
)
