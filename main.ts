/**
 * A script for Nginx-NJS to update Cloudflare DNS records.
 * Require SSL(https) support.
 * 
 * @copyright izGroup
 * @version 1.0.0
 * @license MIT
 */

/// <reference path="../type/index.d.ts" />
/// <reference path="../type/ngx_http_js_module.d.ts" />

interface Zone  {
    "id": string,
    "name": string,
    "status": "active" | "disabled",
    "paused": boolean,
    "type": "full" | "partial",
    "owner": Object,
    "account": Object,
    "permissions": Array<string>,
    "plan": Record<string, string | number>
}

interface DomainRecord {
    "id": string,
    "zone_id": string,
    "zone_name": string,
    "name": string,
    "type": "A" | "AAAA" | "CNAME" | "MX" | "NS" | "SRV" | "TXT",
    "content": string,
    "proxiable": boolean,
    "proxied": boolean,
    "ttl": number,
    "locked": boolean,
    "meta": {
        "auto_added": boolean,
        "managed_by_apps": boolean,
        "managed_by_argo_tunnel": boolean,
        "source": string
    },
    "comment": string | null,
    "tags": Array<string>,
    "created_on": string,
    "modified_on": string
}

class Cloudflare {

    static cloudflare_url = "https://api.cloudflare.com/client/v4";

    private token: string;

    /**
     * 创建一个CloudFlare实例
     * @param token Cloudflare 账号的API Token
     */
	constructor(token: string) {
		this.token = token;
	}

    /**
     * 找到指定域名对应的Zone结构
     * @param name 顶级域名名称
     * @returns Zone结构
     */
	async findZone(name: string): Promise<Zone> {
		const response = await this._fetchWithToken(`zones?name=${name}`);
		const body = await response.json();
		if (!body.success || body.result.length === 0)
			throw new Error(`Failed to find zone '${name}'`);
		return body.result[0];
	}

    /**
     * 在指定Zone中找到指定二级域名记录
     * @param zone Zone结构
     * @param name 二级域名名称
     * @param type 解析类型，如A、AAAA、CNAME等
     * @returns 解析结构
     */
	async findRecord(zone: Zone, name: string, type: string): Promise<DomainRecord> {
		const response = await this._fetchWithToken(`zones/${zone.id}/dns_records?name=${name}`);
		const body = await response.json();
		if (!body.success || body.result.length === 0)
			throw new Error(`Failed to find dns record '${name}'`);
		return (body.result as Array<DomainRecord>)?.filter(rr => rr.type === type)[0];
	}

    /**
     * 更新域名解析记录
     * @param record 解析记录结构
     * @param value 新值
     * @returns 新的解析记录结构
     */
	async updateRecord(record: DomainRecord, value: string) {
		record.content = value;
		const response = await this._fetchWithToken(
			`zones/${record.zone_id}/dns_records/${record.id}`,
			{
				method: "PUT",
				body: JSON.stringify(record),
			}
		);
		const body = await response.json();
		if (!body.success)
			throw new Error("Failed to update dns record");
		return body.result[0];
	}

    /**
     * 创建解析记录
     * @param zone Zone结构
     * @param name 名称
     * @param rrType 二级域名前缀
     * @param value 新值
     * @param ttl TTL时间
     * @returns 解析结构
     */
    async createRecord(zone: Zone, name: string, rrType: "A" | "AAAA", value: string, ttl = 1): Promise<DomainRecord> {
        const response = await this._fetchWithToken(
            `zones/${zone.id}/dns_records`,
            {
                method: "POST",
                body: JSON.stringify({
                    type: rrType,
                    name,
                    content: value,
                    ttl,
                    proxied: false,
                    comment: "Generated by nginx-njs"
                })
            }
        );
        const result = await response.json();
        if (!result.success)
            throw new Error("Failed to create dns record");
        return result.result;
    }

    /**
     * 删除解析
     * @param record 解析结构
     */
    async deleteRecord(record: DomainRecord) { 
        const response = await this._fetchWithToken(
            `zones/${record.zone_id}/dns_records/${record.id}`,
            {
                method: "DELETE"
            }
        );
        const result = await response.json();
        if (!result.success)
            throw new Error("Failed to delete dns record");
    }

	private async _fetchWithToken(endpoint: string, options: RequestInit = {}) {
		const url = `${Cloudflare.cloudflare_url}/${endpoint}`;
		options.headers = {
			...options.headers,
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.token}`
		};
		return fetch(url, options);
	}
}

async function update(h: NginxPeriodicSession){
    // 读取环境变量
    const user_token = h.variables.ddns_cf_token,
        domain = h.variables.ddns_cf_domain,
        record_name = h.variables.ddns_cf_record_name,
        record_type = h.variables.ddns_cf_record_type,
        ipapi = h.variables.ddns_ipapi;

    if(!user_token || !domain || !record_name || !record_type || !ipapi)
        throw new Error("Missing required parameters");

    const ddns = new Cloudflare(user_token);

    // 尝试寻找缓存
    if('ddns_cache' in h.variables){
        const [zone_name, key] = (h.variables.ddns_cache as string).split('.');
        if(zone_name in ngx.shared){
            // 有缓存
            if(ngx.shared[zone_name].has(key)){
                const cache = JSON.parse(ngx.shared[zone_name].get(key) as string);
                var {zone, record} = cache as {zone: Zone, record: DomainRecord};
            }else{
                var zone = await ddns.findZone(domain),
                    record = await ddns.findRecord(zone, record_name, record_type);
            }
        }else{
            throw new Error("Failed to find cacheZone");
        }
    }else{
        var zone = await ddns.findZone(domain),
            record = await ddns.findRecord(zone, record_name, record_type);
    }

    // 获取新IP
    const ip = await (await fetch(ipapi)).text();

    // 更新记录
    if(record.content !== ip){
        record = await ddns.updateRecord(record, ip);
    }

    // 更新缓存
    if( ('ddns_cache' in h.variables) && ngx.shared[zone.name] && 
        (!ngx.shared[zone.name].has(zone.id)) || ip !== record.content
    ){
        const cache = {zone, record};
        ngx.shared[zone.name].set(zone.id, JSON.stringify(cache));
    }
}

function statusHTML(h: NginxHTTPRequest){
    if(!h.variables.ddns_cache) return h.return(500, "No cache found");
    const [cache_zone, cache_key] = (h.variables.ddns_cache as string).split('.');

    if(cache_zone in ngx.shared && ngx.shared[cache_zone].has(cache_key)){
        const cache = JSON.parse(ngx.shared[cache_zone].get(cache_key) as string);
        const {zone, record} = cache as {zone: Zone, record: DomainRecord};
        h.headersOut['Content-Type'] = 'text/plain';
        h.return(200, `这是你的域名详细信息，请查收
域名：${record.name}.${zone.name} (${record.type})
上一次更新: ${record.modified_on}
记录值: ${record.content}`);
    }else{
        return h.return(500, "Failed to find cache");
    }
}

export default { 
    main: (h: NginxPeriodicSession) => update(h).catch(e => ngx.log(ngx.ERR, `Thread exited unexpectedly: ${new String(e)}`)),
    status: (h: NginxHTTPRequest) => statusHTML(h)
}