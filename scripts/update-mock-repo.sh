#!/bin/bash

# Create temp directory
mkdir -p temp_ci_store

# Clone the repo (using depth 1 for speed)
echo "Cloning CI-App-Store..."
git clone --depth 1 https://github.com/companionintelligence/CI-App-Store temp_ci_store

# Zip the contents
echo "Zipping repository..."
cd temp_ci_store
# Install zip if not present? Assuming it is.
zip -r ../packages/backend/mock-auth-server/repo.zip .

# Cleanup
cd ..
rm -rf temp_ci_store

echo "Done! repo.zip created in packages/backend/mock-auth-server/"
