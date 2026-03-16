import paramiko
import time

def run_deep_cleanup():
    host = "193.203.15.249"
    user = "root"
    pw = "b9qs9jGu6rD5ojgpGg5"

    print(f"Connecting to {host}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=pw)

    # We will use a Lua script to safely scan and delete job hashes.
    # We protect keys ending in :id, :meta, :waiting, :active, :completed, :failed, :delayed, :stalled, :repeat, :limiter, :priority
    # These are BullMQ infrastructure keys.
    # Everything else starting with bull: and having at least 2 colons is likely a job hash.
    # Example: bull:myQueue:123
    
    # We'll use a more robust Python-based scan to avoid Lua timeouts
    print("Starting deep cleanup of job hashes...")
    cursor = '0'
    total_deleted = 0
    protected = [':id', ':meta', ':waiting', ':active', ':completed', ':failed', ':delayed', ':stalled', ':repeat', ':limiter', ':priority']
    
    while True:
        # Scan for bull:*:*
        # Increased count to 50000 for faster scanning
        cmd = f"redis-cli SCAN {cursor} MATCH 'bull:*:*' COUNT 50000"
        stdin, stdout, stderr = client.exec_command(cmd)
        lines = stdout.read().decode().splitlines()
        
        if not lines:
            break
        
        new_cursor = lines[0]
        # Everything from line 1 onwards are keys
        keys = lines[1:]
        
        keys_to_del = []
        for key in keys:
            is_protected = False
            for p in protected:
                if key.endswith(p):
                    is_protected = True
                    break
            if not is_protected:
                keys_to_del.append(key)
        
        if keys_to_del:
            # Delete in chunks of 5000 to avoid command length limits
            chunk_size = 5000
            for i in range(0, len(keys_to_del), chunk_size):
                chunk = keys_to_del[i:i + chunk_size]
                print(f"Deleting {len(chunk)} keys (Total so far: {total_deleted})...")
                del_cmd = f"redis-cli del {' '.join(chunk)}"
                client.exec_command(del_cmd)
                total_deleted += len(chunk)
            
        cursor = new_cursor
        if cursor == '0':
            break
            
    print(f"Deep cleanup complete. Deleted {total_deleted} job hashes.")

    # Final check of memory
    stdin, stdout, stderr = client.exec_command("redis-cli info memory | grep used_memory_human")
    print(f"Memory after: {stdout.read().decode().strip()}")

    client.close()

if __name__ == "__main__":
    run_deep_cleanup()
