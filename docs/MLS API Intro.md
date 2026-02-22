# MLS Grid Documentation

## MLS Grid API Overview

### Benefits&#x20;

**Brokers:** [ONE set of rules and display guidelines](https://www.mlsgrid.com/overview). Reduce expenses by working with ONE with data feed, ONE set of rules and ONE compliance process. Future national IDX option and valuable analytics for evaluating usage and value of vendor products and consumer behaviors.

**MLSs:** ONE data feed and [license](https://www.mlsgrid.com/s/MLS-GRID-Data-License-Agreement.pdf) to The MLS Grid for IDX, VOW and third-party vendors. Reduce expenses by sharing licensing and compliance overhead with all MLSs participating in the MLS Grid. Control of approved vendors and their access to listings, as well as quarterly compliance audits of the websites where listings are displayed.

**Vendors:** [ONE standard license agreement,](https://www.mlsgrid.com/s/MLS-GRID-Data-License-Agreement.pdf) data feed and compliance enforcement. Reduce expenses working with one source for data feeds and compliance requirements.

**And More:** Go to [www.mlsgrid.com](http://www.mlsgrid.com) to see all the benefits.

## MLS Grid Data & Conversion <a href="#mls-grid-data--conversion" id="mls-grid-data--conversion"></a>

To help you familiarize yourself with the MLS Grid it is important to understand how we get our data, and what we do with that data. That is what this section covers.

### MLS Data Import <a href="#mls-data-import" id="mls-data-import"></a>

We gather our data from each MLS using the most efficient means available. This includes all resource types and any accompanying images.

This is accomplished with the following steps:

1. Gets the raw data using and timestamp delta.
2. Downloads any media assets for each record.
3. Uploads each media asset to Amazon S3 and creates a media record for each.
4. Converts each record from it's native MLS format to RESO data dictionary standard, keeping any non conforming fields.

### Import Frequency <a href="#import-frequency" id="import-frequency"></a>

Our policy is to import as frequently as possible. Unless there is a restriction in place from the MLS, we check for changes every minute from our member MLSs.

This results in very fast turn around on both records and images. We take this performance very seriously, and track it for everyone to see. To see current performance metrics you can login to your MLS Grid account and click on the "MLS Import Status" on the left menu to see a screen showing the latest import status for each MLS.

We display an up-to-date metric of the speed at which a record is added to the MLS and time till it is available for retrieval from our service.

### Conversion Process & Rules <a href="#conversion-process--rules" id="conversion-process--rules"></a>

As noted previously, each record passes through a conversion process before it finds its way to our customers. This conversion process converts, if possible, the MLS data to the latest data dictionary standards.

**Data Dictionary Conversion Process**

**What we convert**

The data dictionary defines field names and in specific fields, namely lookup fields (enumerations), also field values. Converting from one field name to another is already fraught with difficulty, field values are another matter altogether.

For this reason, at this time the MLS Grid conversion rules only concern themselves with field names (unless specified otherwise). This means that fields that are converted from an MLS local field to a data dictionary field with lookup values will **retain** the same value, regardless if that value is defined as a lookup field option in the Data Dictionary rules.

### **How we handle date fields**

Finally, it's worth noting that **ALL date fields are converted to a DD field are represented in UTC**, regardless of the MLS they are sourced from. Any date fields passed through as a local field are kept in their original representation.

**Modification Fields**

The data dictionary defines a modification timestamp field for each resource. For example, for **property** the following field is used to track modifications:

| Field Name            | Description                                     |
| --------------------- | ----------------------------------------------- |
| ModificationTimestamp | When the property data was updated by the Grid. |

The value of the ModificationTimestamp field coming from the Grid is the time that the record was modified by us. The OriginatingSystemModificationTimestamp contains the source MLS modification time.&#x20;

To quickly demonstrate how this works. Let's consider a property record from MRED in Chicago.

The native record you would receive from the MLS currently might look like this:

```javascript
{
  "RECORDMODDATE" : "2018-01-10T21:40:12", 
  // and the rest
}
```

The MLS Grid will take this record, run it through the conversion process and when it is available to consume it will update the modification timestamps. The resulting record could approximate the following:

```javascript
{  
  "ModificationTimestamp": "[time we set]",
  // and the rest
}
```

## MLS Grid Service & API <a href="#mls-grid-service--api" id="mls-grid-service--api"></a>

The MLS Grid service provides everything from unified licensing to a simpler subscription process. This section covers the data retrieval process for developers through our API.

We do not support real time data access at this time.  Our service provides the data through a data replication process.  This will be the case for the foreseeable future while we focus on providing a stable data platform and work towards providing real time data at some point in the future. &#x20;

Even though our focus is on replication, we are using the newer Web API to service this need. The Web API provides a lot of exciting things for developers:

* Modern RESTful API, as is more common through the tech world and easier to test because of this.
* For real time use it has a more well thought out query language for expressive data access capabilities.

To make the Web API as fast as possible for the use of replication, we've created a standard Web API that does away with all the capabilities needed for real time use and focused only on the features needed for replication.

The result of this is a faster Web API that restricts the consumer to querying using specific fields needed for replication.

### Authentication <a href="#authentication" id="authentication"></a>

The MLS Grid uses a simplified Oauth 2 authentication schema with long term tokens. Because trust has already been established via the subscription sign up process, generating these tokens is simple and done through the Web Application interface.

Once a subscription has been created, a licensee added, and the MLS has approved, an API token will be generated and presented on the token tab when viewing a subscription.

Contact support if you need to have your token re-generated to invalidate the old token.&#x20;

### API Access <a href="#api-access" id="api-access"></a>

For additional information about how to use the API for replication, please review our [`API Documentation`](https://docs.mlsgrid.com/api-documentation/api-version-2.0) which contains the specifications [Version 2.0](https://docs.mlsgrid.com/api-documentation/api-version-2.0) of our API.&#x20;

### Media Files

You must maintain your own copy of all media files. The URLs contained in the Media resource are to be used ONLY for the purpose of downloading a local copy of the files. DO NOT use these URLs on your website or in your application. In order to retrieve the photo associated with the media record, you will need to use the url provided in the MediaURL field to download the file. The url is for the highest resolution photo that the MLS provides to us.

If you do not wish to store a local copy of all the media files we recommend using a caching service like CloudFront to only cache the images you need. This saves cost for both of us.&#x20;

### Deleted Records

**MlgCanView - Deleted Listings, Off Market Listings, Etc**

Each record in the system has a field called MlgCanView which is a boolean field and indicates whether the record should be kept in your database or not. This is how we have implemented our delete mechanism. When you receive an updated record during replication, you should first check this flag to see what action to take with your local copy of the record.

* IF **true**, then save or update the existing record in your db.
* IF **false**, then remove the record from your database (or never save it in the first place).

This value can be changed to false based on a number of different reasons. \
The following are a few example reasons: &#x20;

* The property was deleted.
* The property listing office decided that they don't want to feed out any of their listings.
* The property changed status and made it unavailable in IDX
* Etc.

The MlgCanView field is a specific field to the MLS Grid that tells you whether the record should be kept in your database. (note that any field with the prefix "Mlg" is specific to the Grid)

### Dynamic Field Data

The data coming from our system will not always contain every field for every record.  Each record contains only the fields converted from its originating source MLS. The metadata contains definitions for the fields in our data but not all fields apply to every record.

### Rate Limits

The MLSGrid has the following rate limits and data caps in place for all data consumers.&#x20;

1. No more than 2 request per second (RPS) at all times.
2. No more than 7,200 request submitted in any given hour.&#x20;
3. No more than 4 GB downloaded in any given hour.&#x20;
4. No more than 40,000 requests submitted per 24 hour period.

* In cases where it may be necessary to exceed these limits please contact <support@mlsgrid.com> in advance for guidance

As activity on your access token becomes concerning an email is sent to the email address of the Primary Contact on your vendor account. If the activity exceeds the limits in under an hour period, the access token will be suspended and a shut-off message sent to the Primary email address. Messages regarding behavior will also appear on your MLS Grid timeline. If your API access has been suspended your client will receive an HTTP 429 error in response to any requests. This error will include details of the concerning behavior.

In the emails you receive will be details of the concerning behavior or the reason your access token was suspended. A link in the email will take you to the Usage tab of your MLS Grid data subscription where a more detailed breakdown of the activity can be viewed. We encourage you to click on the Take Me To The MLS Grid button in the email in order to view the usage tab of your MLS Grid account for a more detailed breakdown of what the concerning behavior may be.

When your access token has been suspended for concerning behavior the permissions for the token will be automatically reinstated once enough time has passed that the number of requests submitted or amount of data consumed falls back within these limits.

You can view your hourly summary of your usage by clicking on the Usage tab in your data subscription and see the 24 hour breakdown by clicking on the Usage Logs button at the bottom of the page.&#x20;

1. Log in to your MLS Grid account
2. Click on Manage Subscriptions in the left side navigation menu
3. Click on the Edit Data Subscription Details button
4. Locate the Usage tab