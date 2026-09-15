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
