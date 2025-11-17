#!/bin/bash

echo "--------------------------------------------"
echo "   🚀 SHAPPI INVENTORY APP DEPLOY SCRIPT"
echo "--------------------------------------------"
echo ""

# Ask for commit message
read -p "Enter commit message: " msg

# Determine current branch
current_branch=$(git rev-parse --abbrev-ref HEAD)

echo ""
echo "📌 Current branch: $current_branch"
echo ""

# 1. Add all changes
echo "➕ Staging changes..."
git add .

# 2. Commit
echo "📝 Committing changes..."
git commit -m "$msg"

# 3. Push current branch
echo "⬆️  Pushing $current_branch to origin..."
git push origin $current_branch

# 4. Switch to main
echo "🔄 Switching to main..."
git checkout main

# 5. Pull latest main
echo "⬇️  Pulling latest main..."
git pull origin main

# 6. Merge feature branch → main
echo "🔀 Merging $current_branch → main..."
git merge $current_branch

# 7. Push main
echo "⬆️  Deploying to Render via main push..."
git push origin main

echo ""
echo "--------------------------------------------"
echo "   🟩 Git push to main complete."
echo "   Render will auto-deploy if configured."
echo "--------------------------------------------"
echo ""

# 8. OPTIONAL: Trigger Render deploy via CLI
if command -v render &> /dev/null
then
    read -p "Do you want to force a manual Render deploy via CLI? (y/n): " run_render
    if [[ "$run_render" == "y" || "$run_render" == "Y" ]]; then
        echo "🚀 Triggering manual Render deployment..."
        render deploy inventory-check-universal
    else
        echo "Skipping manual Render deployment."
    fi
else
    echo "⚠️ Render CLI not installed. Skipping manual deploy step."
fi

echo ""
echo "🎉 DEPLOYMENT COMPLETE!"
echo ""

