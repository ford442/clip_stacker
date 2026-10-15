# Host (non-Emscripten) flags for native DSP tests. Include from native/CMakeLists.txt
# when CLIP_STACKER_HOST_TESTS=ON; WASM modules use toolchain.cmake instead.
#
# -ffp-contract=off keeps float results in step with the WASM build (SIMD128 has
# no fused multiply-add), so golden numbers hold on FMA hosts (aarch64) too.

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Release or Debug" FORCE)
endif()

option(CLIP_STACKER_HOST_SANITIZE "AddressSanitizer + UBSan for host tests" OFF)

function(clip_stacker_host_target target)
  target_compile_features(${target} PUBLIC cxx_std_17)
  target_compile_options(${target} PRIVATE -Wall -Wextra -ffp-contract=off)
  if(CLIP_STACKER_HOST_SANITIZE)
    target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)
    target_link_options(${target} PRIVATE -fsanitize=address,undefined)
  endif()
endfunction()

# Test executable from one .cpp, linked to a module's DSP library and run by ctest.
function(clip_stacker_host_test name source dsp_lib)
  add_executable(${name} ${source})
  target_link_libraries(${name} PRIVATE ${dsp_lib})
  target_include_directories(${name} PRIVATE "${CLIP_STACKER_NATIVE_DIR}/host_test")
  clip_stacker_host_target(${name})
  add_test(NAME ${name} COMMAND ${name})
endfunction()

set(CLIP_STACKER_NATIVE_DIR "${CMAKE_CURRENT_LIST_DIR}")
