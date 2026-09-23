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
