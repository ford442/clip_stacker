cmake_minimum_required(VERSION 3.16)
project(clip_stacker_wasm LANGUAGES C CXX)

include("${CMAKE_CURRENT_LIST_DIR}/toolchain.cmake")

file(MAKE_DIRECTORY "${CLIP_STACKER_PUBLIC_WASM}")

add_subdirectory(audio_analysis)
add_subdirectory(time_stretch)
add_subdirectory(video_stabilize)
add_subdirectory(media_engine)
