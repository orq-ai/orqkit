#!/bin/bash
# Restricted helper script for Claude to manage review comments
# Only allows specific, safe GraphQL operations

set -e

# Security: Validate all arguments contain only safe characters (whitelist approach)
# This prevents command injection via &&, ||, ;, |, $(), etc.
validate_arg() {
  local arg="$1"
  # Only allow alphanumeric, underscore, hyphen, equals, colon, forward slash, at, and dot
  # This blocks ALL shell metacharacters and command substitution attempts
  if [[ "$arg" =~ [^a-zA-Z0-9_=:/@.-] ]]; then
    echo "Error: Invalid characters detected in argument. Only alphanumeric and _=:/@.- allowed."
    echo "Rejected value: $arg"
    exit 1
  fi
}

ACTION=$1
shift

# Validate action argument
validate_arg "$ACTION"

case "$ACTION" in
  "get-review-threads")
    # Query PR review threads with comment status
    OWNER=$1
    REPO=$2
    PR_NUMBER=$3

    # Validate all arguments
    validate_arg "$OWNER"
    validate_arg "$REPO"
    validate_arg "$PR_NUMBER"

    gh api graphql -f query="
      query(\$owner: String!, \$repo: String!, \$number: Int!) {
        repository(owner: \$owner, name: \$repo) {
          pullRequest(number: \$number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                comments(first: 100) {
                  nodes {
                    id
                    databaseId
                    author { login }
                    body
                    isMinimized
                    minimizedReason
                    createdAt
                  }
                }
              }
            }
          }
        }
      }" -f owner="$OWNER" -f repo="$REPO" -F number="$PR_NUMBER"
    ;;

  "minimize-comment")
    # Minimize a specific comment (must be from claude[bot])
    COMMENT_ID=$1
    CLASSIFIER=${2:-OUTDATED}  # Default to OUTDATED

    # Validate arguments
    validate_arg "$COMMENT_ID"
    validate_arg "$CLASSIFIER"

    # Validate classifier
    case "$CLASSIFIER" in
      OUTDATED|RESOLVED|DUPLICATE|OFF_TOPIC)
        ;;
      *)
        echo "Error: Invalid classifier. Must be OUTDATED, RESOLVED, DUPLICATE, or OFF_TOPIC"
        exit 1
        ;;
    esac

    # First, verify the comment belongs to claude[bot]
    AUTHOR=$(gh api graphql -f query="
      query(\$commentId: ID!) {
        node(id: \$commentId) {
          ... on PullRequestReviewComment {
            author {
              login
            }
          }
        }
      }" -f commentId="$COMMENT_ID" --jq '.data.node.author.login')

    if [ "$AUTHOR" != "claude" ] && [ "$AUTHOR" != "claude[bot]" ]; then
      echo "Error: Can only minimize comments authored by 'claude' or 'claude[bot]'. Found author: '$AUTHOR'"
      exit 1
    fi

    # Proceed with minimization
    gh api graphql -f query="
      mutation(\$commentId: ID!, \$classifier: ReportedContentClassifiers!) {
        minimizeComment(input: {subjectId: \$commentId, classifier: \$classifier}) {
          minimizedComment {
            isMinimized
            minimizedReason
          }
        }
      }" -f commentId="$COMMENT_ID" -f classifier="$CLASSIFIER"
    ;;

  "resolve-thread")
    # Resolve a review thread (must contain only claude[bot] comments)
    THREAD_ID=$1

    # Validate argument
    validate_arg "$THREAD_ID"

    # First, verify all comments in the thread belong to claude[bot]
    AUTHORS=$(gh api graphql -f query="
      query(\$threadId: ID!) {
        node(id: \$threadId) {
          ... on PullRequestReviewThread {
            comments(first: 100) {
              nodes {
                author {
                  login
                }
              }
            }
          }
        }
      }" -f threadId="$THREAD_ID" --jq '.data.node.comments.nodes[].author.login' | sort -u)

    # Check if all authors are claude or claude[bot]
    while IFS= read -r author; do
      if [ "$author" != "claude" ] && [ "$author" != "claude[bot]" ]; then
        echo "Error: Can only resolve threads where all comments are from 'claude' or 'claude[bot]'. Found author: '$author'"
        exit 1
      fi
    done <<< "$AUTHORS"

    # Proceed with resolution
    gh api graphql -f query="
      mutation(\$threadId: ID!) {
        resolveReviewThread(input: {threadId: \$threadId}) {
          thread {
            id
            isResolved
          }
        }
      }" -f threadId="$THREAD_ID"
    ;;

  "unresolve-thread")
    # Unresolve a review thread (must contain only claude[bot] comments)
    THREAD_ID=$1

    # Validate argument
    validate_arg "$THREAD_ID"

    # First, verify all comments in the thread belong to claude[bot]
    AUTHORS=$(gh api graphql -f query="
      query(\$threadId: ID!) {
        node(id: \$threadId) {
          ... on PullRequestReviewThread {
            comments(first: 100) {
              nodes {
                author {
                  login
                }
              }
            }
          }
        }
      }" -f threadId="$THREAD_ID" --jq '.data.node.comments.nodes[].author.login' | sort -u)

    # Check if all authors are claude or claude[bot]
    while IFS= read -r author; do
      if [ "$author" != "claude" ] && [ "$author" != "claude[bot]" ]; then
        echo "Error: Can only unresolve threads where all comments are from 'claude' or 'claude[bot]'. Found author: '$author'"
        exit 1
      fi
    done <<< "$AUTHORS"

    # Proceed with unresolution
    gh api graphql -f query="
      mutation(\$threadId: ID!) {
        unresolveReviewThread(input: {threadId: \$threadId}) {
          thread {
            id
            isResolved
          }
        }
      }" -f threadId="$THREAD_ID"
    ;;

  *)
    echo "Error: Unknown action '$ACTION'"
    echo "Allowed actions: get-review-threads, minimize-comment, resolve-thread, unresolve-thread"
    exit 1
    ;;
esac
