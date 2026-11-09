# Host (non-Emscripten) flags for native DSP tests. Include from native/CMakeLists.txt
# when CLIP_STACKER_HOST_TESTS=ON; WASM modules use toolchain.cmake instead.
#
# -ffp-contract=off keeps float results in step with the WASM build (SIMD128 has
# no fused multiply-add; toolchain.cmake passes the same flag), so golden numbers
# hold on FMA hosts (aarch64) too.
# -Werror: first-party code is warning-free; keep it that way. Vendored code
# (kissfft) opts out per source file.
#
# Sanitizers (CLIP_STACKER_HOST_SANITIZE): ASan + UBSan plus an explicit
# -fsanitize=float-cast-overflow (an out-of-range float -> int conversion):
# GCC leaves it out of -fsanitize=undefined, clang includes it. CI runs both
# compilers (the clang job also builds the libFuzzer targets).
#
# CLIP_STACKER_HOST_FUZZ (clang only): libFuzzer targets (`*_fuzz`), not run
# by ctest; see scripts/fuzz-native.sh.

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Release or Debug" FORCE)
endif()

option(CLIP_STACKER_HOST_SANITIZE "AddressSanitizer + UBSan for host tests" OFF)
option(CLIP_STACKER_HOST_FUZZ "Build libFuzzer targets (clang only)" OFF)

set(CLIP_STACKER_NATIVE_DIR "${CMAKE_CURRENT_LIST_DIR}")
set(CLIP_STACKER_COMMON_INCLUDE "${CLIP_STACKER_NATIVE_DIR}/common/include")

set(CLIP_STACKER_SANITIZERS "address,undefined,float-cast-overflow")
if(CLIP_STACKER_HOST_FUZZ AND NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  message(FATAL_ERROR "CLIP_STACKER_HOST_FUZZ needs clang (libFuzzer): configure with CXX=clang++")
endif()

function(clip_stacker_host_target target)
  target_compile_features(${target} PUBLIC cxx_std_17)
  set_target_properties(${target} PROPERTIES CXX_EXTENSIONS OFF C_EXTENSIONS OFF)
  target_include_directories(${target} PUBLIC "${CLIP_STACKER_COMMON_INCLUDE}")
  target_compile_options(${target} PRIVATE -Wall -Wextra -Werror -ffp-contract=off)
  if(CLIP_STACKER_HOST_SANITIZE)
    target_compile_options(${target} PRIVATE -fsanitize=${CLIP_STACKER_SANITIZERS} -fno-omit-frame-pointer
                                             -fno-sanitize-recover=all)
    target_link_options(${target} PRIVATE -fsanitize=${CLIP_STACKER_SANITIZERS})
  endif()
  if(CLIP_STACKER_HOST_FUZZ)
    # Coverage instrumentation for the libraries the fuzz targets link.
    target_compile_options(${target} PRIVATE -fsanitize=fuzzer-no-link)
  endif()
endfunction()

# Test executable from one .cpp, linked to a module's DSP library and run by
# ctest twice: `<name>` (--fast, label `pr`: what every PR runs) and
# `<name>_long` (--long, label `nightly`: LONG_TEST_CASEs, see host_test.h).
function(clip_stacker_host_test name source dsp_lib)
  add_executable(${name} ${source})
  target_link_libraries(${name} PRIVATE ${dsp_lib})
  target_include_directories(${name} PRIVATE "${CLIP_STACKER_NATIVE_DIR}/host_test")
  clip_stacker_host_target(${name})
  add_test(NAME ${name} COMMAND ${name} --fast)
  set_tests_properties(${name} PROPERTIES LABELS "pr")
  add_test(NAME ${name}_long COMMAND ${name} --long)
  set_tests_properties(${name}_long PROPERTIES LABELS "nightly")
endfunction()

# libFuzzer target from one .cpp (CLIP_STACKER_HOST_FUZZ only; not a ctest).
function(clip_stacker_host_fuzz name source dsp_lib)
  if(NOT CLIP_STACKER_HOST_FUZZ)
    return()
  endif()
  add_executable(${name} ${source})
  target_link_libraries(${name} PRIVATE ${dsp_lib})
  clip_stacker_host_target(${name})
  target_compile_options(${name} PRIVATE -fsanitize=fuzzer)
  target_link_options(${name} PRIVATE -fsanitize=fuzzer)
endfunction()
