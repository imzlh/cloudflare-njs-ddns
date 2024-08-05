# CFDDNS-njs
Use your NGINX to auto update your domain record!<br>
Easy-to-use, single-file, full NJS feature!

add this to your custom nginx.conf

    js_import           ddns from cfddns.js;
    js_shared_dict_zone zone=njs:1m type=string;
    location @ddns{
        js_var          $ddns_cf_token          "[CloudFlare API Token]";
        js_var          $ddns_cf_domain         "[domain, for example: imzlh.top]";
        js_var          $ddns_cf_record_name    "[full domain, for example: cloud.imzlh.top]";
        js_var          $ddns_cf_record_type    "[AAAA for ipv6, A for ipv4]";
        js_var          $ddns_ipapi             "[https://6.ipw.cn for ipv6, https://4.ipw.cn for ipv4]";
        js_var          $ddns_cache             njs.cfddns;
        js_periodic     ddns.main               interval=60s;
    }

And then, your ddns WORKS!

    2024/08/05 18:16:30 [info] 2779#0: js: Cache miss for imzlh.top
    2024/08/05 18:16:33 [info] 2779#0: js: No need to update cloud.imzlh.top.imzlh.top (AAAA) to 2409:...

If you want to know status, just add it to `nginx.conf` and visit `/@ddns`:

    location = /@ddns{
        js_var                  $ddns_cache     "njs.cfddns";
        js_content              ddns.status;
    }