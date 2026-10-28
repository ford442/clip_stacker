# Shared Emscripten flags for clip_stacker WASM modules.
# Include this from module CMakeLists — do NOT pass it as CMAKE_TOOLCHAIN_FILE
# (emcmake already injects the Emscripten toolchain).
#
# Release (default): -O3 -DNDEBUG -msimd128 -flto --closure 1 → public/wasm/
# Debug (CMAKE_BUILD_TYPE=Debug or -DCLIP_STACKER_WASM_DEBUG=ON):
#   -O0 -g -s ASSERTIONS=1 --profiling-funcs → native/build-debug/wasm/, served
#   at /wasm-debug/ by the dev and preview servers and picked by `?wasm_debug`.
#   Debug output never overwrites the committed release artifacts.
#
# ENVIRONMENT=web,worker (not node). The glue resolves the .wasm with
# `new URL(..., import.meta.url)` by default (emsdk >= 4 removed
# USE_ES6_IMPORT_META=0); src/wasm/emscriptenLoader.ts always passes
# `locateFile`, so that default is never used and Vite never sees it (the glue
# is not bundled). INCOMING_MODULE_JS_API is the whole factory-options
# contract: `locateFile`, plus `instantiateWasm`, which Vitest uses to compile
# file:// bytes itself (Node's fetch rejects file:, and emsdk >= 5 no longer
# reads `wasmBinary` by default).
#
# No pthreads by default: only the opt-in whisper target sets THREADS (ggml's
# worker pool). COOP/COEP is already on for FFmpeg.

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
set(CLIP_STACKER_COMMON_INCLUDE "${CLIP_STACKER_NATIVE_DIR}/common/include")
if(CLIP_STACKER_WASM_DEBUG)
  set(CLIP_STACKER_WASM_OUT "${CLIP_STACKER_NATIVE_DIR}/build-debug/wasm")
else()
  set(CLIP_STACKER_WASM_OUT "${CLIP_STACKER_ROOT}/public/wasm")
endif()

# EXTRA_RUNTIME_METHODS: appended to the shared EXPORTED_RUNTIME_METHODS.
# GZIP_BUDGET: per-module override (0 = no check). THREADS: -pthread.
# EXCEPTIONS: link C++ throw support for third-party code that throws
# (whisper.cpp); catching stays off, so a throw still aborts the module.
function(clip_stacker_wasm_module target)
  cmake_parse_arguments(ARG "THREADS;EXCEPTIONS"
    "EXPORT_NAME;INITIAL_MEMORY;MAXIMUM_MEMORY;GZIP_BUDGET"
    "EXPORTED_FUNCTIONS;EXTRA_RUNTIME_METHODS;EXTRA_LINK_OPTIONS"
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
  if(NOT DEFINED ARG_GZIP_BUDGET)
    set(ARG_GZIP_BUDGET "${CLIP_STACKER_WASM_GZIP_BUDGET}")
  endif()

  target_compile_features(${target} PUBLIC cxx_std_17)
  set_target_properties(${target} PROPERTIES CXX_EXTENSIONS OFF C_EXTENSIONS OFF)
  target_include_directories(${target} PRIVATE "${CLIP_STACKER_COMMON_INCLUDE}")
  target_compile_options(${target} PRIVATE
    -msimd128
    -Wall
    -Wextra
    $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
  )
  if(NOT ARG_EXCEPTIONS)
    target_compile_options(${target} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>)
    target_link_options(${target} PRIVATE -fno-exceptions)
  endif()

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
  set(_runtime "HEAPF32,HEAPF64,HEAPU8,HEAP32")
  foreach(fn IN LISTS ARG_EXTRA_RUNTIME_METHODS)
    string(APPEND _runtime ",${fn}")
  endforeach()

  target_link_options(${target} PRIVATE
    "SHELL:-s WASM=1"
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_ES6=1"
    "SHELL:-s EXPORT_NAME=${ARG_EXPORT_NAME}"
    "SHELL:-s ENVIRONMENT=web,worker"
    "SHELL:-s FILESYSTEM=0"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s INITIAL_MEMORY=${ARG_INITIAL_MEMORY}"
    "SHELL:-s MAXIMUM_MEMORY=${ARG_MAXIMUM_MEMORY}"
    "SHELL:-s STACK_SIZE=${CLIP_STACKER_WASM_STACK_SIZE}"
    "SHELL:-s EXPORTED_FUNCTIONS=${_exports}"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=${_runtime}"
    "SHELL:-s INCOMING_MODULE_JS_API=locateFile,instantiateWasm"
    "SHELL:-s NO_EXIT_RUNTIME=1"
    -msimd128
    ${ARG_EXTRA_LINK_OPTIONS}
  )

  if(ARG_THREADS)
    target_compile_options(${target} PRIVATE -pthread)
    target_link_options(${target} PRIVATE -pthread)
  endif()

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
    RUNTIME_OUTPUT_DIRECTORY "${CLIP_STACKER_WASM_OUT}"
    LIBRARY_OUTPUT_DIRECTORY "${CLIP_STACKER_WASM_OUT}"
    SUFFIX ".js"
  )

  # The budget is for shipped (release) modules; -O0 -g output is far larger.
  if(NOT CLIP_STACKER_WASM_DEBUG AND ARG_GZIP_BUDGET GREATER 0)
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND "${CMAKE_COMMAND}" -E env "WASM_GZIP_BUDGET=${ARG_GZIP_BUDGET}"
              "${CLIP_STACKER_ROOT}/scripts/wasm-size-check.sh"
              "${CLIP_STACKER_WASM_OUT}/$<TARGET_FILE_BASE_NAME:${target}>.wasm"
      COMMENT "gzip budget check for ${target}"
      VERBATIM
    )
  endif()
endfunction()

# A glue-free module (`-sSTANDALONE_WASM --no-entry`): plain extern "C"
# exports and its own exported memory, no Emscripten JS runtime. For realms
# that cannot load the MODULARIZE glue — the AudioWorkletGlobalScope has no
# fetch / importScripts — so JS compiles the .wasm and instantiates it with a
# handful of WASI stubs. Same compile flags, size budget and debug switch as
# `clip_stacker_wasm_module`; output is `<target>.wasm` only.
function(clip_stacker_standalone_wasm target)
  cmake_parse_arguments(ARG "" "INITIAL_MEMORY;MAXIMUM_MEMORY;GZIP_BUDGET" "EXPORTED_FUNCTIONS" ${ARGN})
  if(NOT ARG_INITIAL_MEMORY)
    set(ARG_INITIAL_MEMORY 1048576)
  endif()
  if(NOT ARG_MAXIMUM_MEMORY)
    set(ARG_MAXIMUM_MEMORY 33554432)
  endif()
  if(NOT DEFINED ARG_GZIP_BUDGET)
    set(ARG_GZIP_BUDGET "${CLIP_STACKER_WASM_GZIP_BUDGET}")
  endif()

  target_compile_features(${target} PUBLIC cxx_std_17)
  set_target_properties(${target} PROPERTIES CXX_EXTENSIONS OFF C_EXTENSIONS OFF)
  target_include_directories(${target} PRIVATE "${CLIP_STACKER_COMMON_INCLUDE}")
  target_compile_options(${target} PRIVATE
    -msimd128
    -Wall
    -Wextra
    $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
    $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
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
    "SHELL:-s STANDALONE_WASM=1"
    --no-entry
    -fno-exceptions
    "SHELL:-s FILESYSTEM=0"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s INITIAL_MEMORY=${ARG_INITIAL_MEMORY}"
    "SHELL:-s MAXIMUM_MEMORY=${ARG_MAXIMUM_MEMORY}"
    "SHELL:-s STACK_SIZE=${CLIP_STACKER_WASM_STACK_SIZE}"
    "SHELL:-s EXPORTED_FUNCTIONS=${_exports}"
    -msimd128
  )
  if(CLIP_STACKER_WASM_DEBUG)
    target_link_options(${target} PRIVATE -O0 -g "SHELL:-s ASSERTIONS=1" "SHELL:--profiling-funcs")
  else()
    target_link_options(${target} PRIVATE -O3 -flto)
  endif()

  set_target_properties(${target} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CLIP_STACKER_WASM_OUT}"
    SUFFIX ".wasm"
  )

  if(NOT CLIP_STACKER_WASM_DEBUG AND ARG_GZIP_BUDGET GREATER 0)
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND "${CMAKE_COMMAND}" -E env "WASM_GZIP_BUDGET=${ARG_GZIP_BUDGET}"
              "${CLIP_STACKER_ROOT}/scripts/wasm-size-check.sh"
              "${CLIP_STACKER_WASM_OUT}/${target}.wasm"
      COMMENT "gzip budget check for ${target}"
      VERBATIM
    )
  endif()
endfunction()
