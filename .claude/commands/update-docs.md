# Update Documentation

Analyze the codebase and update project documentation files.

## Instructions

1. **Analyze the codebase thoroughly:**
   - Scan all files in `lib/`, `app/`, and root config files
   - Identify all components, their status (complete/partial/missing)
   - Check implementation status of each module
   - Note any new files, removed files, or significant changes

2. **Update ARCHITECTURE.md:**
   - Update the system overview diagram if needed
   - Update "Current State Summary" (What's Working, In Progress, Not Working)
   - Update implementation status matrix
   - Update file structure section
   - Update environment variables if any new ones added
   - Keep the detailed flow diagrams accurate

3. **Update CLAUDE.md:**
   - Keep it concise (this is the quick reference)
   - Update file structure table
   - Update current status section
   - Update any changed commands or configurations
   - Ensure environment variables are current

4. **Guidelines:**
   - Be accurate - verify each status by reading the actual code
   - Use consistent status indicators: ✅ Complete, ⚠️ Partial, ❌ Not Started
   - Don't remove useful documentation, only update outdated parts
   - Preserve the existing structure and formatting style

5. **After updating, report:**
   - List of changes made to each file
   - Any new components discovered
   - Any issues or inconsistencies found
