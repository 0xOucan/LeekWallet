cmake_minimum_required(VERSION 3.16.0)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# ---------------------------------------------------------------------------
# Re-run CMake when HEAD moves.
#
# ESP-IDF stamps the short commit hash into esp_app_desc_t as PROJECT_VER, and
# it computes that with `git describe` at *configure* time. Nothing in the
# generated ninja graph depends on git state, so after a new commit an
# incremental `pio run` relinks nothing and the image keeps reporting the
# previous commit. Verified, not theorised: a build made at f90755c still
# reported 1e9231d.
#
# That is worse than a cosmetic bug. The whole point of stamping the commit is
# so a binary can name the source it was built from; a stamp that lies makes
# every downstream check - "does this board run the release I published?" -
# answer confidently and wrongly.
#
# The reflog is the file to watch. HEAD itself holds `ref: refs/heads/<branch>`
# and does not change when you commit on that branch, and refs/heads/<branch>
# may be packed away entirely; logs/HEAD is appended to by every commit,
# checkout, reset and merge. Both are resolved through `git rev-parse
# --git-path` so this works in a worktree, where .git is a file and the real
# git directory lives elsewhere.
#
# Failing to find git is not an error: a source tarball with no git history is
# a legitimate way to build this, and IDF falls back to version "1" on its own.
# ---------------------------------------------------------------------------
find_package(Git QUIET)
if(GIT_FOUND)
    foreach(git_file HEAD logs/HEAD)
        execute_process(
            COMMAND ${GIT_EXECUTABLE} rev-parse --git-path ${git_file}
            WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
            OUTPUT_VARIABLE git_path
            OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET)
        if(git_path AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/${git_path}")
            set(git_path "${CMAKE_CURRENT_LIST_DIR}/${git_path}")
        endif()
        if(git_path AND EXISTS "${git_path}")
            set_property(DIRECTORY APPEND PROPERTY
                         CMAKE_CONFIGURE_DEPENDS "${git_path}")
        endif()
    endforeach()
endif()

project(leekwallet)
