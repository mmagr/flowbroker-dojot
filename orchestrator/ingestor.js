var axios = require("axios");
var util = require('util');
var kafka = require('./kafka');

var amqp = require('./amqp');
var config = require('./config');

module.exports = class DeviceIngestor {
  /**
   * Constructor.
   * @param {FlowManagerBuilder} fmBuilder Builder instance to be used when parsing received events
   */
  constructor(fmBuilder) {
    // map of active consumers (used to detect topic rebalancing by kafka)
    this.consumers = {};
    this.fmBuiler = fmBuilder;
    this.amqp = new amqp.AMQPProducer(config.amqp.queue);
  }

  /**
   * Lists current known tenants in the platform
   * @return {[Promise]}  List of known tenants in the platform
   */
  listTenants() {
    return new Promise((resolve, reject) => {
      axios({
        'url': config.tenancy.manager + '/admin/tenants'
      }).then((response) => {
        resolve(response.data.tenants);
      }).catch((error) => {
        reject(error);
      })
    })
  }

  /**
   * Initialize iotagent kafka consumers (for tenant and device events)
   * @return {[undefined]}
   */
  initConsumer() {
    let consumer = new kafka.Consumer('internal', config.tenancy.subject, true);

    consumer.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data.value.toString());
      } catch (e) {
        console.error('Received tenancy event is not valid json. Ignoring.');
        return;
      }

      this.bootstrapTenant(parsed.tenant);
    });

    consumer.on('connect', () => {
      if (!this.consumers.hasOwnProperty('tenancy')) {
        // console.log('got connect event - tenancy');
        this.listTenants().then((tenants) => {
          for (let t of tenants) {
            this.bootstrapTenant(t);
          }
        }).catch((error) => {
          const message = "Failed to acquire existing tenancy contexts"
          console.error("[ingestor] %s\n", message, error);
          throw new InitializationError(message);
        })
        console.log('[ingestor] Tenancy context management initialized');
        this.consumers['tenancy'] = true;
      }
    })
  }

  /**
   * Given a tenant, initialize the related device event stream ingestor.
   *
   * @param  {[string]} tenant tenant which ingestion stream is to be initialized
   */
  bootstrapTenant(tenant) {
    const consumerid = tenant + ".device";
    if (this.consumers.hasOwnProperty(consumerid)) {
      console.log('[ingestor] Attempted to re-init device consumer for tenant:', tenant);
      return;
    }

    let consumer = new kafka.Consumer(tenant, config.ingestion.subject);
    this.consumers[consumerid] = true;

    consumer.on('connect', () => {
      console.log(`[ingestor] Device consumer ready for tenant: ${tenant}`);
    })

    consumer.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data.value.toString());
      } catch (e) {
        console.error("[ingestor] Device event is not valid json. Ignoring.");
        return;
      }

      this.handleEvent(parsed);
    });

    consumer.on('error', (error) => {
      console.error('[ingestor:kafka] Consumer for tenant "%s" is errored.', tenant);
    });
  }

  _publish(node, message, flow, metadata) {
    // This should work for single output nodes only!
    for (let output of node.wires) {
      for (let hop of output) {
        this.amqp.sendMessage(JSON.stringify({
          hop: hop,
          message: message,
          flow: flow,
          metadata: {
            tenant: metadata.tenant,
            originator: metadata.deviceid
          }
        }));
      }
    }
  }

  handleFlow(event, flow, isTemplate) {
    flow.nodeMap = {};
    for (let node of flow.red) {
      flow.nodeMap[node.id] = node;
    }

    for (let head of flow.heads) {
      const node = flow.nodeMap[head];
      // handle input by device
      if (node.hasOwnProperty('_device_id') &&
          (node._device_id == event.metadata.deviceid) &&
          (isTemplate == false)) {
        this._publish(node, {payload: event.attrs}, flow, event.metadata);
      }

      // handle input by template
      if (node.hasOwnProperty('_device_template_id') &&
          (event.metadata.templates.includes(node._device_template_id)) &&
          (isTemplate == true)) {
        this._publish(node, {payload: event.attrs}, flow, event.metadata);
      }
    }
  }

  handleEvent(event) {
    console.log(`[ingestor] got new device event: ${util.inspect(event, {depth: null})}`);
    let flowManager = this.fmBuiler.get(event.metadata.tenant);
    flowManager.getByDevice(event.metadata.deviceid).then((flowlist) => {
      for (let flow of flowlist) {
        this.handleFlow(event, flow, false);
      }
    })

    for (let template of event.metadata.templates) {
      flowManager.getByTemplate(template).then((flowlist) => {
        for (let flow of flowlist) {
          this.handleFlow(event, flow, true);
        }
      })
    }
  }
}