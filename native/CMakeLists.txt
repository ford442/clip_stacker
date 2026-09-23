cmake_minimum_required(VERSION 3.16)
project(clip_stacker_wasm LANGUAGES C CXX)

# Host (non-Emscripten) build: native DSP test binaries run by ctest, no emcmake.
#   cmake -S native -B native/build-host -DCLIP_STACKER_HOST_TESTS=ON
# See scripts/test-native.sh.
option(CLIP_STACKER_HOST_TESTS "Build host DSP test binaries instead of WASM modules" OFF)

if(CLIP_STACKER_HOST_TESTS)
  if(EMSCRIPTEN)
    message(FATAL_ERROR "CLIP_STACKER_HOST_TESTS builds native executables; configure with plain cmake, not emcmake")
  endif()
  include("${CMAKE_CURRENT_LIST_DIR}/host.cmake")
  enable_testing()
  add_subdirectory(media_engine)
  return()
endif()

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "native/ builds WASM modules: configure with emcmake (scripts/emscripten-flags.sh), or pass -DCLIP_STACKER_HOST_TESTS=ON for host tests")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/toolchain.cmake")

file(MAKE_DIRECTORY "${CLIP_STACKER_PUBLIC_WASM}")

add_subdirectory(audio_analysis)
add_subdirectory(time_stretch)
add_subdirectory(video_stabilize)
add_subdirectory(media_engine)
