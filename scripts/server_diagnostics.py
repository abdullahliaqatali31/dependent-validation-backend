import paramiko
import os
import sys
import json
from datetime import datetime

# Server Configuration (Update these or pass via env vars)
SERVER_IP = os.getenv('SERVER_IP', '193.203.15.249')
SSH_USER = os.getenv('SSH_USER', 'root') # Usually root for these VPS, user didn't specify but IP is common for VPS
SSH_PASSWORD = os.getenv('SSH_PASSWORD', 'b9qs9jGu6rD5ojgpGg5')
SSH_KEY_PATH = os.getenv('SSH_KEY_PATH', None)

def run_command(client, command):
    print(f"Executing: {command}")
    stdin, stdout, stderr = client.exec_command(command)
    exit_status = stdout.channel.recv_exit_status()
    output = stdout.read().decode('utf-8')
    error = stderr.read().decode('utf-8')
    return output, error, exit_status

def main():
    if SERVER_IP == 'YOUR_SERVER_IP':
        print("Error: Please set SERVER_IP, SSH_USER, and SSH_KEY_PATH.")
        sys.exit(1)

    try:
        # Initialize SSH client
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        
        # Connect to server
        print(f"Connecting to {SERVER_IP}...")
        if SSH_KEY_PATH:
            client.connect(hostname=SERVER_IP, username=SSH_USER, key_filename=SSH_KEY_PATH)
        else:
            client.connect(hostname=SERVER_IP, username=SSH_USER, password=SSH_PASSWORD)

        report = {
            "timestamp": datetime.now().isoformat(),
            "system_info": {},
            "redis_info": {},
            "db_info": {},
            "pm2_info": {}
        }

        # 1. System Health
        print("Checking system health...")
        report["system_info"]["uptime"], _, _ = run_command(client, "uptime")
        report["system_info"]["memory"], _, _ = run_command(client, "free -m")
        report["system_info"]["disk"], _, _ = run_command(client, "df -h /")

        # 2. Redis Health (Enhanced)
        print("Checking Redis health...")
        report["redis_info"]["memory"], _, _ = run_command(client, "redis-cli info memory | grep used_memory_human")
        report["redis_info"]["clients"], _, _ = run_command(client, "redis-cli info clients | grep connected_clients")
        report["redis_info"]["keys"], _, _ = run_command(client, "redis-cli dbsize")
        
        # BullMQ specific check (look for keys ending in :waiting, :active, etc)
        print("Analyzing BullMQ queues...")
        q_cmd = "redis-cli --scan --pattern '*:waiting' | xargs -L 1 redis-cli llen"
        # This might be slow, let's just count keys per pattern instead
        q_patterns = ['bull:dedupe:*', 'bull:filter:*', 'bull:validation:*', 'bull:personal:*']
        report["redis_info"]["queues"] = {}
        for p in q_patterns:
            count, _, _ = run_command(client, f"redis-cli --scan --pattern '{p}' | wc -l")
            report["redis_info"]["queues"][p] = count.strip()

        # 3. PM2 Health
        print("Checking PM2 health...")
        report["pm2_info"]["status"], _, _ = run_command(client, "pm2 list")
        report["pm2_info"]["logs"], _, _ = run_command(client, "pm2 logs --lines 100 --no-colors csi-workers")

        # 4. Database Health (Fixing command)
        print("Checking Database health...")
        # Try without sudo first or using the DATABASE_URL pattern if we can find it
        db_query = "SELECT relname AS table_name, pg_size_pretty(pg_total_relation_size(relid)) AS total_size, n_live_tup FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;"
        # Since we are root, we can try psql directly
        db_cmd = f"psql -d csi_db -c \"{db_query}\""
        report["db_info"]["table_sizes"], err, _ = run_command(client, db_cmd)
        if err:
             report["db_info"]["error"] = err

        # Output the report
        report_path = f"diagnostic_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_path, "w") as f:
            json.dump(report, f, indent=4)

        print(f"\nDiagnostic completed. Report saved to {report_path}")
        
        # Print summary for immediate view
        print("\n--- Summary ---")
        print(f"System Uptime: {report['system_info']['uptime'].strip()}")
        print(f"Redis Memory: {report['redis_info']['memory'].strip()}")
        print(f"Redis Keys: {report['redis_info']['keys'].strip()}")
        
        client.close()

    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
