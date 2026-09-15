add_executable(time_stretch time_stretch.cpp)
target_include_directories(time_stretch PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

clip_stacker_wasm_module(time_stretch
  EXPORT_NAME createTimeStretchModule
  INITIAL_MEMORY 4194304
  MAXIMUM_MEMORY 536870912
  EXPORTED_FUNCTIONS
    _time_stretch_remap
    _time_stretch_constant
)
