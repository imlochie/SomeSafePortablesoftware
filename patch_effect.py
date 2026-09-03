import re

with open('artifacts/archive-assistant/src/App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

old_effect = """  useEffect(() => {
    setIsScanning(scan?.status === 'scanning');
  }, [scan?.status]);"""

new_effect = """  useEffect(() => {
    const wasScanning = isScanning;
    const nowScanning = scan?.status === 'scanning';
    setIsScanning(nowScanning);
    
    if (wasScanning && !nowScanning) {
      queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
    }
  }, [scan?.status, isScanning, queryClient]);"""

if old_effect in content:
    content = content.replace(old_effect, new_effect)
    with open('artifacts/archive-assistant/src/App.tsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Patched useEffect successfully.")
else:
    print("Could not find old_effect.")
