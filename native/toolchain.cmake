# Shared Emscripten flags for clip_stacker WASM modules.
# Include this from module CMakeLists — do NOT pass it as CMAKE_TOOLCHAIN_FILE
# (emcmake already injects the Emscripten toolchain).
#
# Release (default): -O3 -DNDEBUG -msimd128 -flto --closure 1
# Debug (CMAKE_BUILD_TYPE=Debug or -DCLIP_STACKER_WASM_DEBUG=ON):
#   -O0 -g -s ASSERTIONS=1 --profiling-funcs
#
# No pthreads: COOP/COEP is already on for FFmpeg; threads only pay off once
# mix is streaming + multi-clip (phase 2).

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Release or Debug" FORCE)
endif()

option(CLIP_STACKER_WASM_DEBUG "WASM debug symbols (-O0 -g, assertions)" OFF)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(CLIP_STACKER_WASM_DEBUG ON)
endif()

set(CLIP_STACKER_WASM_STACK_SIZE "131072" CACHE STRING "Explicit WASM stack (bytes)")
set(CLIP_STACKER_WASM_GZIP_BUDGET "204800" CACHE STRING "Fail if gzip(wasm) exceeds this")

get_filename_component(CLIP_STACKER_NATIVE_DIR "${CMAKE_CURRENT_LIST_DIR}" ABSOLUTE)
get_filename_component(CLIP_STACKER_ROOT "${CLIP_STACKER_NATIVE_DIR}/.." ABSOLUTE)
set(CLIP_STACKER_PUBLIC_WASM "${CLIP_STACKER_ROOT}/public/wasm")

function(clip_stacker_wasm_module target)
  cmake_parse_arguments(ARG ""
    "EXPORT_NAME;INITIAL_MEMORY;MAXIMUM_MEMORY"
    "EXPORTED_FUNCTIONS"
    ${ARGN}
  )

  if(NOT ARG_EXPORT_NAME)
    message(FATAL_ERROR "${target}: EXPORT_NAME is required")
  endif()
  if(NOT ARG_INITIAL_MEMORY)
    set(ARG_INITIAL_MEMORY 4194304)
  endif()
  if(NOT ARG_MAXIMUM_MEMORY)
    set(ARG_MAXIMUM_MEMORY 67108864)
  endif()

  target_compile_features(${target} PUBLIC cxx_std_17)
  target_compile_options(${target} PRIVATE
    -msimd128
    $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
    $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
  )

  if(CLIP_STACKER_WASM_DEBUG)
    target_compile_options(${target} PRIVATE -O0 -g)
    target_compile_definitions(${target} PRIVATE DEBUG)
  else()
    target_compile_options(${target} PRIVATE -O3 -flto)
    target_compile_definitions(${target} PRIVATE NDEBUG)
  endif()

  set(_exports "_malloc,_free")
  foreach(fn IN LISTS ARG_EXPORTED_FUNCTIONS)
    string(APPEND _exports ",${fn}")
  endforeach()

  target_link_options(${target} PRIVATE
    "SHELL:-s WASM=1"
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_ES6=1"
    "SHELL:-s EXPORT_NAME=${ARG_EXPORT_NAME}"
    "SHELL:-s ENVIRONMENT=web,worker,node"
    "SHELL:-s FILESYSTEM=0"
    "SHELL:-s USE_PTHREADS=0"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s INITIAL_MEMORY=${ARG_INITIAL_MEMORY}"
    "SHELL:-s MAXIMUM_MEMORY=${ARG_MAXIMUM_MEMORY}"
    "SHELL:-s STACK_SIZE=${CLIP_STACKER_WASM_STACK_SIZE}"
    "SHELL:-s EXPORTED_FUNCTIONS=${_exports}"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,HEAP32"
    "SHELL:-s NO_EXIT_RUNTIME=1"
    -msimd128
    -fno-exceptions
  )

  if(CLIP_STACKER_WASM_DEBUG)
    target_link_options(${target} PRIVATE
      -O0 -g
      "SHELL:-s ASSERTIONS=1"
      "SHELL:--profiling-funcs"
    )
  else()
    target_link_options(${target} PRIVATE -O3 -flto "SHELL:--closure 1")
  endif()

  set_target_properties(${target} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CLIP_STACKER_PUBLIC_WASM}"
    LIBRARY_OUTPUT_DIRECTORY "${CLIP_STACKER_PUBLIC_WASM}"
    SUFFIX ".js"
  )

  add_custom_command(TARGET ${target} POST_BUILD
    COMMAND "${CLIP_STACKER_ROOT}/scripts/wasm-size-check.sh"
            "${CLIP_STACKER_PUBLIC_WASM}/$<TARGET_FILE_BASE_NAME:${target}>.wasm"
    COMMENT "gzip budget check for ${target}"
    VERBATIM
  )
endfunction()
