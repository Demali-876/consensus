import IC "ic:aaaaa-aa";
import Text "mo:base/Text";
import Error "mo:base/Error";
import Nat "mo:base/Nat";
import Blob "mo:base/Blob";
import Result "mo:base/Result";
import Env "../env";

actor {
  
  public query func transform({
    context : Blob;
    response : IC.http_request_result;
  }) : async IC.http_request_result {
    {
      response with headers = [];
    };
  };

  private func escapeJson(text : Text) : Text {
    let chars = text.chars();
    var result = "";
    for (char in chars) {
      switch (char) {
        case ('\"') { result #= "\\\""; };
        case ('\\') { result #= "\\\\"; };
        case ('\n') { result #= "\\n"; };
        case ('\r') { result #= "\\r"; };
        case ('\t') { result #= "\\t"; };
        case (_) { result #= Text.fromChar(char); };
      };
    };
    result;
  };

  public func send_sms_ic(message : Text) : async Result.Result<Text, Text> {
    let host : Text = Env.infobip_host;
    let url = "https://" # host # "/sms/2/text/advanced";
    let api_key = Env.infobip_api_key;
    let from_number = Env.infobip_from_number;
    let auth_header = "App " # api_key;
    
    let request_headers : [IC.http_header] = [
      { name = "idempotency-key"; value = "idempotency_key_001"},
      { name = "Content-Type"; value = "application/json" },
      { name = "Accept"; value = "application/json" },
      { name = "Authorization"; value = auth_header },
    ];

    let escaped_message = escapeJson(message);
    let json_payload = "{\"messages\":[{\"destinations\":[{\"to\":\"" # Env.to_number # "\"}],\"from\":\"" # from_number # "\",\"text\":\"" # escaped_message # "\"}]}";
    
    let http_request : IC.http_request_args = {
      url = url;
      max_response_bytes = ?2048;
      headers = request_headers;
      body = ?Text.encodeUtf8(json_payload);
      method = #post;
      transform = ?{
        function = transform;
        context = Blob.fromArray([]);
      };
    };
    
    try {
      let http_response : IC.http_request_result = await (with cycles = 800_000_000) IC.http_request(http_request);
      if (http_response.status >= 200 and http_response.status < 300) {
        #ok("SMS request sent successfully to BIP follow on BIP side to see if request was completed");
      } else {
        let response_body : Blob = http_response.body;
        let error_message = switch (Text.decodeUtf8(response_body)) {
          case (null) { "Unknown error" };
          case (?message) { message };
        };
        #err("Failed to send SMS: " # error_message);
      };
    } catch (e) {
      #err("Error making HTTP request: " # Error.message(e));
    };
  };

  public func send_sms_consensus(message : Text) : async Result.Result<Text, Text> {
    let proxy_url = Env.proxy_url;
    let proxy_api_key = Env.consensus_api_key;
    let infobip_url = "https://" # Env.infobip_host # "/sms/2/text/advanced";
    let from_number = Env.infobip_from_number;
    let auth_header = "App " # Env.infobip_api_key;
    let escaped_message = escapeJson(message);

    let target_payload = "{" #
      "\"target_url\":\"" # infobip_url # "\"," #
      "\"method\":\"POST\"," #
      "\"headers\":{" #
        "\"Authorization\":\"" # auth_header # "\"," #
        "\"Content-Type\":\"application/json\"," #
        "\"x-idempotency-key\":\"sms-test" # "motoko" # "\"" #
      "}," #
      "\"body\":{" #
        "\"messages\":[{" #
          "\"destinations\":[{\"to\":\"" # Env.to_number # "\"}]," #
          "\"from\":\"" # from_number # "\"," #
          "\"text\":\"" # escaped_message # "\"" #
        "}]" #
      "}" #
    "}";

    let request_headers : [IC.http_header] = [
      { name = "X-API-Key"; value = proxy_api_key },
      { name = "Content-Type"; value = "application/json" },
      { name = "Accept-Encoding"; value = "identity" }
    ];
    
    let http_request : IC.http_request_args = {
      url = proxy_url;
      max_response_bytes = ?4096;
      headers = request_headers;
      body = ?Text.encodeUtf8(target_payload);
      method = #post;
      transform = ?{
        function = transform;
        context = Blob.fromArray([]);
      };
    };
    
    try {
      let http_response : IC.http_request_result = await (with cycles = 800_000_000) IC.http_request(http_request);
      if (http_response.status >= 200 and http_response.status < 300) {
        #ok("SMS sent via consensus proxy.");
      } else {
        let error_message = switch (Text.decodeUtf8(http_response.body)) {
          case (null) "Unknown error";
          case (?m) m;
        };
        #err("Failed via proxy: " # error_message);
      };
    } catch (e) {
      #err("Proxy request error: " # Error.message(e));
    };
  };
};