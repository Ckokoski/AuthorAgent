#!/bin/bash

# Fractured World - Git Push Script
# Usage: ./push.sh
# This script adds all changes and pushes to remote using commit message from commit_message file

set -e

# Check if commit_message file exists
if [ ! -f "commit_message" ]; then
    echo "❌ Error: commit_message file not found in root directory"
    echo "Please create commit_message with your commit message first"
    exit 1
fi

# Read commit message from file
COMMIT_MESSAGE=$(cat commit_message)

# Check if commit message is empty
if [ -z "$COMMIT_MESSAGE" ]; then
    echo "❌ Error: commit_message file is empty"
    exit 1
fi

# Show what we're about to do
echo "📦 Adding all changes..."
git add .

echo ""
echo "📝 Commit message:"
echo "---"
echo "$COMMIT_MESSAGE"
echo "---"
echo ""

# Commit with message from file
echo "💾 Committing changes..."
git commit -m "$COMMIT_MESSAGE"

# Push to remote
echo "🚀 Pushing to remote..."
git push

# Verify push succeeded
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully pushed all changes to GitHub!"

    # Clean up commit_message file after successful push
    rm commit_message
    echo "🧹 Cleaned up commit_message file"

    echo ""
    git log --oneline -3
else
    echo "❌ Push failed. Please check your connection and try again."
    echo "💡 commit_message file preserved for retry"
    exit 1
fi
