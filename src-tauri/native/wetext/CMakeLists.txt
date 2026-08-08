cmake_minimum_required(VERSION 3.18)
project(wetext_bridge LANGUAGES CXX)

include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(HAVE_BIN OFF CACHE BOOL "" FORCE)
set(HAVE_SCRIPT OFF CACHE BOOL "" FORCE)
set(HAVE_COMPACT OFF CACHE BOOL "" FORCE)
set(HAVE_COMPRESS OFF CACHE BOOL "" FORCE)
set(HAVE_CONST OFF CACHE BOOL "" FORCE)
set(HAVE_FAR OFF CACHE BOOL "" FORCE)
set(HAVE_GRM OFF CACHE BOOL "" FORCE)
set(HAVE_PDT OFF CACHE BOOL "" FORCE)
set(HAVE_MPDT OFF CACHE BOOL "" FORCE)
set(HAVE_LINEAR OFF CACHE BOOL "" FORCE)
set(HAVE_LOOKAHEAD OFF CACHE BOOL "" FORCE)
set(HAVE_NGRAM OFF CACHE BOOL "" FORCE)
set(HAVE_PYTHON OFF CACHE BOOL "" FORCE)
set(HAVE_SPECIAL OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  openfst
  URL https://github.com/csukuangfj/openfst/archive/refs/tags/v1.8.5-2026-04-10.tar.gz
  URL_HASH SHA256=c3549940384cbe4fa9f18c2bcfb1bfbd0a80492fd1b0bfa27433cee395a6a199
)
FetchContent_MakeAvailable(openfst)
set_target_properties(fst PROPERTIES OUTPUT_NAME kaldifst_fst)

FetchContent_Declare(
  kaldifst
  URL https://github.com/k2-fsa/kaldifst/archive/ab5bdd013bdf13921e6aeee77db5722ebf9955fb.tar.gz
)
FetchContent_GetProperties(kaldifst)
if(NOT kaldifst_POPULATED)
  FetchContent_Populate(kaldifst)
endif()

set(KALDIFST_CSRC ${kaldifst_SOURCE_DIR}/kaldifst/csrc)
add_library(kaldifst_core STATIC
  ${KALDIFST_CSRC}/context-fst.cc
  ${KALDIFST_CSRC}/kaldi-fst-io.cc
  ${KALDIFST_CSRC}/kaldi-holder.cc
  ${KALDIFST_CSRC}/kaldi-io.cc
  ${KALDIFST_CSRC}/kaldi-math.cc
  ${KALDIFST_CSRC}/kaldi-semaphore.cc
  ${KALDIFST_CSRC}/kaldi-table.cc
  ${KALDIFST_CSRC}/parse-options.cc
  ${KALDIFST_CSRC}/text-normalizer.cc
  ${KALDIFST_CSRC}/text-utils.cc
)
target_compile_features(kaldifst_core PUBLIC cxx_std_17)
target_include_directories(kaldifst_core PUBLIC
  ${kaldifst_SOURCE_DIR}
  ${openfst_SOURCE_DIR}/src/include
)
target_link_libraries(kaldifst_core PUBLIC fst)

add_library(wetext_bridge STATIC bridge.cc)
target_compile_features(wetext_bridge PUBLIC cxx_std_17)
target_link_libraries(wetext_bridge PRIVATE kaldifst_core)

install(TARGETS wetext_bridge kaldifst_core fst
  ARCHIVE DESTINATION lib
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION bin
)
