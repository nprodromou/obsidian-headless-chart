#!/bin/sh
# GIT_ASKPASS helper: answers git's HTTPS prompts from the environment.
case "$1" in
  Username*) printf '%s\n' "${GIT_USERNAME:-x-access-token}" ;;
  *) printf '%s\n' "${GIT_TOKEN:-}" ;;
esac
