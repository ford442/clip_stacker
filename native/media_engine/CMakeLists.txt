add_executable(media_engine
  src/resampler.cpp
  src/audio_mix.cpp
  src/bindings.cpp
)
target_include_directories(media_engine PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

clip_stacker_wasm_module(media_engine
  EXPORT_NAME createMediaEngineModule
  INITIAL_MEMORY 16777216
  MAXIMUM_MEMORY 536870912
  EXPORTED_FUNCTIONS
    _mix_timeline_audio
)
