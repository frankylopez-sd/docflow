const axios = require('axios');

module.exports = async function (context, req) {
  try {
    // Input: Monday hire data from webhook or triggered by "Generate Docs" completion
    const {
      firstName,
      lastName,
      hireDate,
      jobTitle,
      department,
      workLocation,
      residenceState,
      managerName,
      payRate,
      compensationType,
      timeZone,
      workState,
      preferredName,
      personalEmail,
    } = req.body;

    context.log('Creating ADP user for:', firstName, lastName);

    // ADP API credentials from Key Vault
    const adpClientId = process.env.ADP_CLIENT_ID;
    const adpClientSecret = process.env.ADP_CLIENT_SECRET;
    const adpBaseUrl = 'https://api.adp.com';

    // Step 1: Get ADP OAuth token
    const tokenResponse = await axios.post(`${adpBaseUrl}/oauth/token`, {
      client_id: adpClientId,
      client_secret: adpClientSecret,
      grant_type: 'client_credentials',
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const accessToken = tokenResponse.data.access_token;

    // Step 2: Build ADP new hire profile payload
    const adpPayload = {
      employees: [
        {
          person: {
            legalName: {
              givenName: firstName,
              familyName: lastName,
              preferredName: preferredName || firstName,
            },
            contact: {
              personalEmail: personalEmail,
              workEmail: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@medwatchers.com`,
            },
          },
          employment: {
            employmentStatus: {
              statusCode: 'A', // Active
            },
            jobTitle: jobTitle, // PHARMA or CLERK
            department: department, // MEDREV or CLERKS
            reportsTo: managerName,
            locationCode: workLocation,
          },
          workAssignment: {
            timeZone: timeZone, // PST, MST, HST, etc.
            workState: workState, // State where employee works
            payClass: mapPayClass(jobTitle), // Maps PHARMA → PHARMACIST PAY CLASS, etc.
          },
          payroll: {
            payFrequency: 'Biweekly',
            compensationType: compensationType, // Hourly, Salary, Daily
            regularPayRate: payRate,
          },
          tax: {
            federalTaxForm: 'W4',
            suiSdiTaxCode: mapTaxCode(workState), // AR-18, CA-75, UT-28, TX-53, etc.
          },
          workersCompensation: {
            status: 'S', // Subject to PBP
            jobClass: 'DFLT', // Default Governing Class
          },
          hireDate: hireDate,
        },
      ],
    };

    // Step 3: POST to ADP to create worker
    const createResponse = await axios.post(
      `${adpBaseUrl}/hr/v2/workers`,
      adpPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const workerId = createResponse.data.workers[0].id;

    context.res = {
      status: 201,
      body: {
        success: true,
        adpWorkerId: workerId,
        employee: `${firstName} ${lastName}`,
        message: 'ADP user created successfully',
      },
    };

  } catch (error) {
    context.log('Error creating ADP user:', error.message);
    context.res = {
      status: 500,
      body: {
        success: false,
        error: error.message,
      },
    };
  }
};

// Helper: Map Monday Job Title to ADP Pay Class
function mapPayClass(jobTitle) {
  const mapping = {
    'PHARMA': 'PHARMACIST PAY CLASS',
    'CLERK': 'FULL TIME HOURLY',
    'Pharmacist': 'PHARMACIST PAY CLASS',
    'Pharmacy Clerk': 'FULL TIME HOURLY',
  };
  return mapping[jobTitle] || 'FULL TIME HOURLY';
}

// Helper: Map state to ADP tax code
function mapTaxCode(state) {
  const taxCodes = {
    'AR': 'AR-18',
    'CA': 'CA-75',
    'CO': 'CO-15',
    'FL': 'FL-42',
    'GA': 'GA-23',
    'IA': 'IA-86',
    'TX': 'TX-53',
    'UT': 'UT-28',
  };
  return taxCodes[state] || 'UT-28'; // Default to Utah
}
