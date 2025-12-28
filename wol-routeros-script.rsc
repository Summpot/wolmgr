# RouterOS Script for WOL Wake-on-LAN Manager
:global WOL_TASKS_URL "https://your-worker-url.cloudflareworkers.com/api/wol/tasks"
:global WOL_PENDING_URL "https://your-worker-url.cloudflareworkers.com/api/wol/tasks/pending"
:global WOL_NOTIFY_URL "https://your-worker-url.cloudflareworkers.com/api/wol/tasks/notify"
:global INTERVAL 60s ; # Check every 60 seconds

:global WOLManager {
    :local response [/tool fetch url=$WOL_PENDING_URL method=get output=none as-value]
    :local status [:tonum ($response->"status")]

    :if ($status != 200) do={
        :log error "Failed to fetch pending WOL tasks (status: $status)"
        :return
    }

    :local payload [:parsejson ($response->"data")]
    :local tasks [:toarray ($payload->"tasks")]

    :if ([:len $tasks] = 0) do={
        :log info "No pending WOL tasks"
        :return
    }

    :foreach task in=$tasks do={
        :local macAddress ($task->"macAddress")
        :local taskId ($task->"id")
        :log info "Waking $macAddress (task $taskId)"
        /tool wol mac=$macAddress interface=bridge

        :local processingData ("{\"id\":\"$taskId\",\"status\":\"processing\"}")
        /tool fetch url=$WOL_TASKS_URL method=put http-header-field="Content-Type: application/json" http-data=$processingData output=none

        :delay 2s

        :local normalizedMac [:toupper $macAddress]
        :local arpEntry [/ip arp get [find mac-address=$normalizedMac] value=address]
        :local notified false
        :if ($arpEntry != "") do={
            :local notifyData ("{\"id\":\"$taskId\"}")
            /tool fetch url=$WOL_NOTIFY_URL method=post http-header-field="Content-Type: application/json" http-data=$notifyData output=none
            :log info "$macAddress appeared in the ARP table, sending success callback"
            :set notified true
        }

        :if ($notified) do={
            :continue
        }

        :if ($arpEntry != "") do={
            :local pingResult [/ping address=$arpEntry count=3 interval=1s as-value]
            :local received [:tonum ($pingResult->"received")]
            :if ($received > 0) do={
                :local successData ("{\"id\":\"$taskId\",\"status\":\"success\"}")
                /tool fetch url=$WOL_TASKS_URL method=put http-header-field="Content-Type: application/json" http-data=$successData output=none
                :log info "Ping verified $macAddress; updating status to success"
                :continue
            }
        }

        :log error "Unable to confirm $macAddress after WOL; marking as failed"
        :local failedData ("{\"id\":\"$taskId\",\"status\":\"failed\"}")
        /tool fetch url=$WOL_TASKS_URL method=put http-header-field="Content-Type: application/json" http-data=$failedData output=none
    }
}

/system scheduler add name="WOL-Manager" interval=$INTERVAL on-event="$WOLManager" policy=ftp,reboot,read,write,policy,test,password,sniff,sensitive,romon start-time=startup

$WOLManager

:log info "WOL Manager script installed and running!"
